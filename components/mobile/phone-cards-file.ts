/**
 * The cards file on the phone (Learnbox 2.0, Slice 10g): everything the phone holds — courses, cards, answers, card
 * changes and the pictures and sounds — written to one file the learner keeps outside the browser's storage, and read
 * back. Reading needs no Mac. The layout is in core/phone-cards-file.ts.
 *
 * Reading a file: its answers and card changes are always merged in (each once, as not yet sent). Its cards and media
 * replace the phone's only when the phone has none, or the file is newer and the phone has no card change the file
 * lacks (those would be lost with the cards they edited).
 */

import { cardsFileName, cardsFileParts, newOps, newReviews, PHONE_CARDS_KIND, PHONE_CARDS_SCHEMA, readPhoneCardsFile } from "@/src/core";
import type { CardsFileSource, PhoneCardsHeader } from "@/src/core";
import { heldCourseIds } from "./phone-db";
import type { PhoneDb, PhoneMediaFile, PhoneMeta } from "./phone-db";

/** A cards file ready to hand over, and what is in it. */
export interface PreparedCardsFile {
	file: File;
	cards: number;
	courses: number;
	media: number;
	bytes: number;
}

/** Media is read from the phone's storage this many files at a time. */
const MEDIA_BATCH = 20;

/** Gather everything the phone holds into a file; null when it holds nothing yet. */
export async function buildCardsFile(db: PhoneDb, now: Date = new Date(), device?: string): Promise<PreparedCardsFile | null> {
	const snap = await db.load();
	if (!snap) return null;
	const names = (await db.mediaNames()).sort();
	const files: PhoneMediaFile[] = [];
	for (let i = 0; i < names.length; i += MEDIA_BATCH) {
		const batch = names.slice(i, i + MEDIA_BATCH);
		const got = await db.getMedia(batch);
		for (const name of batch) {
			const f = got.get(name);
			if (f) files.push(f);
		}
	}
	const header: PhoneCardsHeader = {
		v: PHONE_CARDS_SCHEMA,
		kind: PHONE_CARDS_KIND,
		createdAt: now.toISOString(),
		...(device ? { device } : {}),
		deckAt: snap.meta.deckAt,
		macReviews: snap.meta.macReviews,
		held: heldCourseIds(snap),
		...(snap.meta.catalog ? { catalog: snap.meta.catalog } : {}),
		courses: snap.courses,
		cards: snap.cards,
		reviews: snap.reviews.filter((r) => r.sent).map((r) => r.review),
		unsent: snap.reviews.filter((r) => !r.sent).map((r) => r.review),
		ops: snap.ops.filter((o) => !o.sent).map((o) => o.op),
		media: files.map((f) => ({ name: f.name, mime: f.mime, size: f.bytes.byteLength })),
	};
	const file = new File(cardsFileParts(header, files.map((f) => f.bytes)), cardsFileName(now), { type: "application/octet-stream" });
	return { file, cards: snap.cards.length, courses: snap.courses.length, media: files.length, bytes: file.size };
}

export type ImportCardsResult =
	/** Not a cards file at all. Nothing was changed. */
	| { kind: "not-ours" }
	/** One of ours, cut short or garbled. Nothing was changed. */
	| { kind: "damaged" }
	| {
			kind: "ok";
			/** The file's cards and media are now the phone's. */
			tookDeck: boolean;
			/** Why they were not: the phone's cards are as new or newer · the phone has card changes the file lacks. */
			skipped?: "phone-newer" | "changes-waiting";
			cards: number;
			courses: number;
			/** Pictures and sounds put on the phone. */
			media: number;
			/** Answers and card changes the phone did not hold yet (now waiting to be sent). */
			addedReviews: number;
			addedOps: number;
			/** Lines of the file that were not answers or card changes. */
			rejected: number;
	  };

/** Read a picked file in. Throws only when the phone's own storage fails. */
export async function importCardsFile(db: PhoneDb, file: CardsFileSource): Promise<ImportCardsResult> {
	const read = await readPhoneCardsFile(file);
	if (!read.ok) return read.reason === "damaged" ? { kind: "damaged" } : { kind: "not-ours" };
	const { header } = read;
	const prior = await db.load();

	let skipped: "phone-newer" | "changes-waiting" | undefined;
	if (prior) {
		if (!(Date.parse(header.deckAt) > Date.parse(prior.meta.deckAt))) skipped = "phone-newer";
		else if (newOps(header.ops, prior.ops.filter((o) => !o.sent).map((o) => o.op)).length > 0) skipped = "changes-waiting";
	}

	let media = 0;
	if (!skipped) {
		const meta: PhoneMeta = {
			v: 1,
			deckAt: header.deckAt,
			// the cards are as old as the Mac's deck they came from, not as new as this moment
			syncedAt: header.deckAt,
			macReviews: header.macReviews,
			courses: header.courses.map((c) => c.id),
			...(header.catalog ? { catalog: header.catalog } : {}),
		};
		const lines = newReviews((prior?.reviews ?? []).map((r) => r.review), header.reviews);
		await db.applyDeck({ meta, courses: header.courses, cards: header.cards, macReviews: lines });
		const have = new Set(await db.mediaNames());
		const want = new Set(read.media.map((m) => m.name));
		await db.deleteMedia([...have].filter((n) => !want.has(n)));
		for (const m of read.media) {
			if (have.has(m.name)) continue;
			await db.putMedia({ name: m.name, mime: m.mime, bytes: await m.read() });
			media += 1;
		}
	}
	const addedReviews = await db.importReviews(header.unsent);
	const addedOps = await db.importOps(header.ops);
	return {
		kind: "ok",
		tookDeck: !skipped,
		...(skipped ? { skipped } : {}),
		cards: header.cards.length,
		courses: header.courses.length,
		media,
		addedReviews,
		addedOps,
		rejected: read.rejected,
	};
}

/** What reading a cards file did, in a sentence. */
export function cardsLoadedText(r: ImportCardsResult): string {
	if (r.kind === "not-ours") return "This is not a Learnbox cards file.";
	if (r.kind === "damaged") return "This cards file is cut short or damaged. Save it again and try once more.";
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
	const extra: string[] = [];
	if (r.addedReviews > 0) extra.push(`${plural(r.addedReviews, "answer")} to send to the Mac`);
	if (r.addedOps > 0) extra.push(`${plural(r.addedOps, "card change")} to send to the Mac`);
	if (r.rejected > 0) extra.push(`${r.rejected} unreadable skipped`);
	const tail = extra.length > 0 ? `; ${extra.join(", ")}` : "";
	if (r.tookDeck) return `Cards file loaded: ${plural(r.cards, "card")} in ${plural(r.courses, "course")}${r.media > 0 ? `, ${plural(r.media, "picture")}` : ""}${tail}.`;
	const why = r.skipped === "changes-waiting" ? "this phone has card changes the file does not have yet — update from the Mac first, or save a new file" : "this phone already has cards that are as new or newer";
	return `Cards not taken: ${why}${tail}.`;
}
