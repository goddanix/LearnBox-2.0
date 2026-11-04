/**
 * Anki import — the pure mapping (contracts/study.ts)
 *
 * Rows read from an Anki collection (schema 18, Anki ≥ 2.1.50: separate
 * decks / notetypes / fields tables) go in; study cards, reviews, a media
 * list and a report come out. NO IO here — the SQLite read and the media
 * copy live in src/store/anki-source.ts, the wiring in src/server/anki-import.ts.
 *
 * Owner decisions (2026-11-04):
 *  - decks → courses: the OWNER maps each Anki deck before the import
 *    (`ImportPlan.decks`); `suggestPlan` only offers a starting point.
 *  - note types by STRUCTURE: the four MedAnki types 1:1; any other cloze
 *    type → cloze; any other type with ≥ 2 fields → basic (first field =
 *    Front, second = Back, the rest keep their names). Reported as remapped.
 *  - media is copied along; the Bildcloze split view is a review-UI concern
 *    that only needs the `LegendCloze` field kept verbatim (it is).
 * Beyond that (conservative, reported, never silent): Anki's native Image
 * Occlusion type is skipped (its masks are drawn by Anki at review time and
 * cannot be reproduced); revlog lines of type 3 (cram) and 4 (manual /
 * rescheduling, which the Deadline Scheduler itself writes) are not reviews.
 */

import type {
	StudyCard,
	StudyCardKind,
	StudyCourse,
	StudyGrade,
	StudyReview,
} from "./contracts/study.ts";

// ─── rows as they come out of the collection ────────────────────────────────

export interface AnkiDeckRow {
	id: number;
	/** Full name, levels joined by U+001F as Anki stores it. */
	name: string;
}
export interface AnkiNoteTypeRow {
	id: number;
	name: string;
	/** Anki's notetype kind: true = cloze (also native Image Occlusion). */
	isCloze: boolean;
	/** Field names in order. */
	fields: string[];
}
export interface AnkiNoteRow {
	id: number;
	mid: number;
	/** Space-separated, padded with spaces. */
	tags: string;
	/** Field values joined by U+001F, in notetype order. */
	flds: string;
}
export interface AnkiCardRow {
	id: number;
	nid: number;
	did: number;
	ord: number;
	/** -1 suspended, -2/-3 buried. */
	queue: number;
	/** Original deck while the card sits in a filtered deck, else 0. */
	odid: number;
}
export interface AnkiRevlogRow {
	/** Epoch ms of the review. */
	id: number;
	cid: number;
	ease: number;
	/** 0 learn, 1 review, 2 relearn, 3 cram, 4 manual / rescheduled. */
	type: number;
	/** Answer time in ms. */
	time: number;
}
export interface AnkiCollection {
	decks: AnkiDeckRow[];
	noteTypes: AnkiNoteTypeRow[];
	notes: AnkiNoteRow[];
	cards: AnkiCardRow[];
	revlog: AnkiRevlogRow[];
}

// ─── small pure helpers ─────────────────────────────────────────────────────

const SEP = "\u001f";
const CORE_TAG = "MedAnki::Kernwissen";

/** Deck levels: "Anatomie\u001fArm" → ["Anatomie", "Arm"]. */
export function deckPath(name: string): string[] {
	return name.split(SEP);
}

/** Readable deck name: "Anatomie::Arm". */
export function deckDisplayName(name: string): string {
	return deckPath(name).join("::");
}

/** Anki's notetype config is a protobuf; `kind` is field 1 (varint, 1 =
 *  cloze) and proto3 omits the default, so absent = normal. Minimal reader. */
export function isClozeConfig(config: Uint8Array): boolean {
	let i = 0;
	const varint = (): number | null => {
		let result = 0;
		let shift = 0;
		while (i < config.length) {
			const b = config[i++] as number;
			result += (b & 0x7f) * 2 ** shift;
			if ((b & 0x80) === 0) return result;
			shift += 7;
		}
		return null;
	};
	while (i < config.length) {
		const tag = varint();
		if (tag === null) return false;
		const field = Math.floor(tag / 8);
		const wire = tag % 8;
		if (wire === 0) {
			const value = varint();
			if (value === null) return false;
			if (field === 1) return value === 1;
		} else if (wire === 2) {
			const len = varint();
			if (len === null) return false;
			i += len;
		} else if (wire === 1) i += 8;
		else if (wire === 5) i += 4;
		else return false;
	}
	return false;
}

const isoOf = (ms: number): string => new Date(ms).toISOString();
const cardIdOf = (ankiCardId: number): string => `anki_${ankiCardId}`;

function slug(name: string): string {
	const s = name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s.length > 0 ? s : "course";
}

// ─── note types ─────────────────────────────────────────────────────────────

const MEDANKI_KINDS: Record<string, StudyCardKind> = {
	"MedAnki Basic": "basic",
	"MedAnki Cloze": "cloze",
	"MedAnki Bildverdeckung": "occlusion",
	"MedAnki MCQ": "mcq",
};

export type UnsupportedReason = "native-image-occlusion" | "too-few-fields";

export interface NoteTypeMapping {
	kind: StudyCardKind;
	/** True when the type was mapped by structure, not by a MedAnki name. */
	remapped: boolean;
	/** Anki field name → study field name, in field order. */
	fieldNames: string[];
}

/** Decide a note type's card kind and field names; a string = unsupported. */
export function mapNoteType(nt: AnkiNoteTypeRow): NoteTypeMapping | UnsupportedReason {
	const known = MEDANKI_KINDS[nt.name];
	if (known) return { kind: known, remapped: false, fieldNames: [...nt.fields] };
	if (nt.fields.includes("Occlusion")) return "native-image-occlusion";
	const kind: StudyCardKind | null = nt.isCloze ? "cloze" : nt.fields.length >= 2 ? "basic" : null;
	if (kind === null) return "too-few-fields";
	const wanted = kind === "cloze" ? ["Text", "Extra"] : ["Front", "Back"];
	const used = new Set<string>();
	const fieldNames = nt.fields.map((original, i) => {
		const base = wanted[i] ?? original;
		let name = base;
		for (let n = 2; used.has(name); n++) name = `${base} ${n}`;
		used.add(name);
		return name;
	});
	return { kind, remapped: true, fieldNames };
}

// ─── media ──────────────────────────────────────────────────────────────────

const SRC_RE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
const SOUND_RE = /\[sound:([^\]]+)\]/g;

/** File names the fields reference (images, audio); remote URLs excluded. */
export function mediaRefs(fields: Record<string, string>): string[] {
	const out = new Set<string>();
	const add = (raw: string | undefined): void => {
		if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return;
		let name = raw;
		try {
			name = decodeURIComponent(raw);
		} catch {
			// keep the raw name
		}
		if (name.length > 0 && !name.includes("/") && !name.includes("\\")) out.add(name);
	};
	for (const value of Object.values(fields)) {
		for (const m of value.matchAll(SRC_RE)) add(m[1] ?? m[2] ?? m[3]);
		for (const m of value.matchAll(SOUND_RE)) add(m[1]);
	}
	return [...out];
}

// ─── plan, inspection ───────────────────────────────────────────────────────

/** What the owner decides before the import. */
export interface ImportPlan {
	/** Courses to create when missing (an existing course is never altered). */
	courses: StudyCourse[];
	/** Anki deck id (as a string) → target; absent or null = skip that deck. */
	decks: Record<string, { courseId: string; topic?: string } | null>;
}

export interface DeckSummary {
	id: number;
	name: string;
	cards: number;
}
export interface AnkiInspection {
	decks: DeckSummary[];
	noteTypes: { name: string; notes: number; supported: boolean; remapped: boolean }[];
	cards: number;
	reviews: number;
}

/** The deck a card belongs to: its original deck while in a filtered one. */
const homeDeck = (c: AnkiCardRow): number => (c.odid !== 0 ? c.odid : c.did);

export function inspectCollection(col: AnkiCollection): AnkiInspection {
	const perDeck = new Map<number, number>();
	for (const c of col.cards) perDeck.set(homeDeck(c), (perDeck.get(homeDeck(c)) ?? 0) + 1);
	const decks = col.decks
		.filter((d) => (perDeck.get(d.id) ?? 0) > 0)
		.map((d) => ({ id: d.id, name: deckDisplayName(d.name), cards: perDeck.get(d.id) ?? 0 }))
		.sort((a, b) => a.name.localeCompare(b.name));
	const noteCount = new Map<number, number>();
	for (const n of col.notes) noteCount.set(n.mid, (noteCount.get(n.mid) ?? 0) + 1);
	const noteTypes = col.noteTypes
		.filter((nt) => (noteCount.get(nt.id) ?? 0) > 0)
		.map((nt) => {
			const m = mapNoteType(nt);
			return {
				name: nt.name,
				notes: noteCount.get(nt.id) ?? 0,
				supported: typeof m !== "string",
				remapped: typeof m !== "string" && m.remapped,
			};
		});
	const importable = col.revlog.filter((r) => r.type !== 3 && r.type !== 4).length;
	return { decks, noteTypes, cards: col.cards.length, reviews: importable };
}

/** A starting point for the owner: top-level deck = course, the rest = topic. */
export function suggestPlan(col: AnkiCollection, now: Date): ImportPlan {
	const courses = new Map<string, StudyCourse>();
	const decks: ImportPlan["decks"] = {};
	for (const d of inspectCollection(col).decks) {
		const original = col.decks.find((x) => x.id === d.id);
		const levels = deckPath(original?.name ?? d.name);
		const top = levels[0] ?? d.name;
		const courseId = slug(top);
		if (!courses.has(courseId)) {
			courses.set(courseId, { id: courseId, name: top, bufferDays: 5, createdAt: now.toISOString() });
		}
		const topic = levels.slice(1).join("::");
		decks[String(d.id)] = topic.length > 0 ? { courseId, topic } : { courseId };
	}
	return { courses: [...courses.values()], decks };
}

// ─── the mapping ────────────────────────────────────────────────────────────

export interface ImportReport {
	cards: number;
	reviews: number;
	/** Cards left out, by reason. */
	skippedCards: {
		unmappedDeck: number;
		noteMissing: number;
		unsupportedNoteType: Record<string, number>;
	};
	/** Revlog lines left out, by reason. */
	skippedReviews: { cramOrManual: number; badEase: number; cardNotImported: number };
	/** Cards whose note type was mapped by structure, per note type name. */
	remapped: Record<string, number>;
}

export interface ImportResult {
	cards: StudyCard[];
	reviews: StudyReview[];
	/** Every media file name the imported cards reference. */
	media: string[];
	report: ImportReport;
}

export function mapCollection(col: AnkiCollection, plan: ImportPlan): ImportResult {
	const report: ImportReport = {
		cards: 0,
		reviews: 0,
		skippedCards: { unmappedDeck: 0, noteMissing: 0, unsupportedNoteType: {} },
		skippedReviews: { cramOrManual: 0, badEase: 0, cardNotImported: 0 },
		remapped: {},
	};
	const noteTypes = new Map(col.noteTypes.map((nt) => [nt.id, nt]));
	const notes = new Map(col.notes.map((n) => [n.id, n]));
	const cards: StudyCard[] = [];
	const media = new Set<string>();
	const imported = new Set<number>();

	for (const c of col.cards) {
		const target = plan.decks[String(homeDeck(c))];
		if (!target) {
			report.skippedCards.unmappedDeck++;
			continue;
		}
		const note = notes.get(c.nid);
		const nt = note ? noteTypes.get(note.mid) : undefined;
		if (!note || !nt) {
			report.skippedCards.noteMissing++;
			continue;
		}
		const mapping = mapNoteType(nt);
		if (typeof mapping === "string") {
			const by = report.skippedCards.unsupportedNoteType;
			by[nt.name] = (by[nt.name] ?? 0) + 1;
			continue;
		}
		const values = note.flds.split(SEP);
		const fields: Record<string, string> = {};
		mapping.fieldNames.forEach((name, i) => {
			fields[name] = values[i] ?? "";
		});
		const tags = note.tags.split(/\s+/).filter((t) => t.length > 0);
		const card: StudyCard = {
			id: cardIdOf(c.id),
			courseId: target.courseId,
			kind: mapping.kind,
			fields,
			tags,
			core: tags.some((t) => t === CORE_TAG || t.startsWith(`${CORE_TAG}::`)),
			origin: { kind: "anki-import", noteId: note.id },
			variant: c.ord,
			createdAt: isoOf(c.id),
			...(target.topic ? { topic: target.topic } : {}),
			...(c.queue === -1 ? { suspended: true } : {}),
		};
		for (const f of mediaRefs(fields)) media.add(f);
		if (mapping.remapped) report.remapped[nt.name] = (report.remapped[nt.name] ?? 0) + 1;
		cards.push(card);
		imported.add(c.id);
	}
	report.cards = cards.length;

	const reviews: StudyReview[] = [];
	for (const r of col.revlog) {
		if (r.type === 3 || r.type === 4) {
			report.skippedReviews.cramOrManual++;
			continue;
		}
		if (r.ease < 1 || r.ease > 4) {
			report.skippedReviews.badEase++;
			continue;
		}
		if (!imported.has(r.cid)) {
			report.skippedReviews.cardNotImported++;
			continue;
		}
		reviews.push({
			cardId: cardIdOf(r.cid),
			at: isoOf(r.id),
			grade: r.ease as StudyGrade,
			...(r.time > 0 ? { ms: r.time } : {}),
		});
	}
	report.reviews = reviews.length;
	return { cards, reviews, media: [...media].sort(), report };
}
