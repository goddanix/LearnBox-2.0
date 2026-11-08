/**
 * The cards file (Learnbox 2.0, Slice 10g): what the phone holds — its courses, cards, answers, card changes and the
 * pictures and sounds — in one file the learner can keep outside the browser's storage (Files, iCloud Drive) and load
 * back, with or without the Mac. Pure: the phone's storage and the share sheet are in components/mobile/phone-cards-file.ts.
 *
 * Layout: 8 bytes of magic · the header's length (4 bytes, big endian) · the header as JSON · the media files' bytes
 * back to back, in the order the header lists them. A picture costs what it weighs (no base64), and a file that was cut
 * short is noticed: the sizes in the header must add up to the file's size exactly.
 */

import { PHONE_CARDS_KIND, PHONE_CARDS_SCHEMA, PHONE_DECK_SCHEMA } from "./contracts/mobile.ts";
import type { PhoneCardsHeader, PhoneCardsMedia } from "./contracts/mobile.ts";
import { cleanTopicChoice, readPhoneDeck } from "./phone-deck.ts";
import { cleanCardOps } from "./phone-ops.ts";
import { cleanReviewLines } from "./phone-sync.ts";

export const PHONE_CARDS_EXTENSION = ".lbdeck";
const MAGIC = "LBDECK1\n";
const PREFIX_BYTES = MAGIC.length + 4;
/** A header bigger than this is not one of ours (a deck's cards as text: tens of MB at the very most). */
const MAX_HEADER_BYTES = 256 * 1024 * 1024;
const MAX_HELD = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** learnbox-cards-2026-11-06-1130.lbdeck (the phone's local time) */
export function cardsFileName(now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `learnbox-cards-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${PHONE_CARDS_EXTENSION}`;
}

/** The file as pieces to hand to `new Blob([...])`: the prefix and header, then each media's bytes. */
export function cardsFileParts(header: PhoneCardsHeader, media: readonly ArrayBuffer[]): (Uint8Array<ArrayBuffer> | ArrayBuffer)[] {
	if (media.length !== header.media.length || header.media.some((m, i) => media[i]!.byteLength !== m.size)) {
		throw new Error("The media of a cards file must match its header.");
	}
	const json = new TextEncoder().encode(JSON.stringify(header));
	const prefix = new Uint8Array(PREFIX_BYTES + json.length);
	prefix.set(new TextEncoder().encode(MAGIC), 0);
	new DataView(prefix.buffer).setUint32(MAGIC.length, json.length, false);
	prefix.set(json, PREFIX_BYTES);
	return [prefix, ...media];
}

const validMediaName = (name: unknown): name is string => typeof name === "string" && name.length > 0 && name.length <= 255 && !/[\\/]/.test(name) && !name.startsWith(".");

/**
 * A header read off a file: the shape is checked, nothing is guessed. Answers and card changes are read line by line
 * (the ones that are not lines are counted); anything that is not a header is null.
 */
export function readPhoneCardsHeader(raw: unknown): { header: PhoneCardsHeader; rejected: number } | null {
	if (!isRecord(raw) || raw.v !== PHONE_CARDS_SCHEMA || raw.kind !== PHONE_CARDS_KIND) return null;
	const { createdAt, deckAt, macReviews, held, media } = raw;
	if (typeof createdAt !== "string" || typeof deckAt !== "string" || !Number.isInteger(macReviews) || (macReviews as number) < 0) return null;
	if (!Array.isArray(held) || held.length > MAX_HELD || !held.every((id) => typeof id === "string")) return null;
	if (!Array.isArray(media) || !media.every((m) => isRecord(m) && validMediaName(m.name) && typeof m.mime === "string" && m.mime.length <= 100 && Number.isInteger(m.size) && (m.size as number) >= 0)) return null;
	const names = media.map((m) => (m as PhoneCardsMedia).name);
	if (new Set(names).size !== names.length) return null;
	const topics = raw.topics === undefined ? undefined : cleanTopicChoice(raw.topics);
	if (topics === null) return null;
	const unsent = cleanReviewLines(raw.unsent ?? []);
	const ops = cleanCardOps(raw.ops ?? []);
	if (!unsent || !ops) return null;
	// courses, cards, the Mac's lines and the catalog are checked the way a deck off the wire is
	const deck = readPhoneDeck({
		v: PHONE_DECK_SCHEMA,
		at: deckAt,
		courses: raw.courses,
		cards: raw.cards,
		reviewsFrom: 0,
		reviews: raw.reviews,
		reviewsTotal: Math.max(macReviews as number, Array.isArray(raw.reviews) ? raw.reviews.length : 0),
		media: [],
		...(raw.catalog !== undefined ? { catalog: raw.catalog } : {}),
	});
	if (!deck) return null;
	const device = typeof raw.device === "string" && raw.device.length <= 80 ? raw.device : undefined;
	return {
		header: {
			v: PHONE_CARDS_SCHEMA,
			kind: PHONE_CARDS_KIND,
			createdAt,
			...(device ? { device } : {}),
			deckAt,
			macReviews: macReviews as number,
			held: held as string[],
			...(topics && Object.keys(topics).length > 0 ? { topics } : {}),
			...(deck.catalog ? { catalog: deck.catalog } : {}),
			courses: deck.courses,
			cards: deck.cards,
			reviews: deck.reviews,
			unsent: unsent.reviews,
			ops: ops.ops,
			media: media as PhoneCardsMedia[],
		},
		rejected: unsent.rejected + ops.rejected,
	};
}

/** What the reader needs of a file: its size and a way to read a part (a `File` or `Blob` is one). */
export interface CardsFileSource {
	readonly size: number;
	slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** One media file of a cards file; its bytes are read when asked for, so a big file is never all in memory at once. */
export interface CardsFileMedia extends PhoneCardsMedia {
	read(): Promise<ArrayBuffer>;
}

export type CardsFileRead =
	| { ok: true; header: PhoneCardsHeader; media: CardsFileMedia[]; rejected: number }
	/** not-ours: no cards file at all · damaged: one of ours that is cut short or garbled. */
	| { ok: false; reason: "not-ours" | "damaged" };

/** Read the header of a picked file and set up its media; nothing else is loaded. */
export async function readPhoneCardsFile(file: CardsFileSource): Promise<CardsFileRead> {
	const not: CardsFileRead = { ok: false, reason: "not-ours" };
	const damaged: CardsFileRead = { ok: false, reason: "damaged" };
	try {
		if (file.size < PREFIX_BYTES) return not;
		const prefix = new Uint8Array(await file.slice(0, PREFIX_BYTES).arrayBuffer());
		if (prefix.length < PREFIX_BYTES || new TextDecoder().decode(prefix.subarray(0, MAGIC.length)) !== MAGIC) return not;
		const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(MAGIC.length, false);
		if (length === 0 || length > MAX_HEADER_BYTES || PREFIX_BYTES + length > file.size) return damaged;
		let raw: unknown;
		try {
			raw = JSON.parse(new TextDecoder().decode(await file.slice(PREFIX_BYTES, PREFIX_BYTES + length).arrayBuffer()));
		} catch {
			return damaged;
		}
		const read = readPhoneCardsHeader(raw);
		if (!read) return damaged;
		const total = read.header.media.reduce((sum, m) => sum + m.size, 0);
		if (PREFIX_BYTES + length + total !== file.size) return damaged;
		let at = PREFIX_BYTES + length;
		const media = read.header.media.map((m): CardsFileMedia => {
			const start = at;
			at += m.size;
			return { ...m, read: async () => file.slice(start, start + m.size).arrayBuffer() };
		});
		return { ok: true, header: read.header, media, rejected: read.rejected };
	} catch {
		return damaged;
	}
}
