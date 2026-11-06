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
/** One Deadline Scheduler record (collection config `deadline_scheduler_deadlines`, by deck id). */
export interface AnkiSchedulerDeadline {
	/** Exam day, "YYYY-MM-DD". */
	deadline: string;
	bufferDays: number;
	/** Manual new-cards-per-day override, when the owner set one. */
	newPerDay?: number;
}
export interface AnkiCollection {
	decks: AnkiDeckRow[];
	noteTypes: AnkiNoteTypeRow[];
	notes: AnkiNoteRow[];
	cards: AnkiCardRow[];
	revlog: AnkiRevlogRow[];
	/** The Deadline Scheduler's records by deck id (as a string); absent = none. */
	deadlines?: Record<string, AnkiSchedulerDeadline>;
}

const isoDay = (v: unknown): v is string =>
	typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** The Scheduler's config object → clean records. Tolerant: anything malformed,
 *  and records the Scheduler marked `expired`, are dropped. */
export function parseSchedulerDeadlines(raw: unknown): Record<string, AnkiSchedulerDeadline> {
	const out: Record<string, AnkiSchedulerDeadline> = {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
	for (const [deckId, value] of Object.entries(raw)) {
		if (typeof value !== "object" || value === null) continue;
		const r = value as Record<string, unknown>;
		if (r.expired === true || !isoDay(r.deadline)) continue;
		const buffer = typeof r.buffer_days === "number" && Number.isFinite(r.buffer_days) ? Math.trunc(r.buffer_days) : 5;
		const perDay = typeof r.new_per_day === "number" && Number.isFinite(r.new_per_day) ? Math.trunc(r.new_per_day) : 0;
		out[deckId] = {
			deadline: r.deadline,
			bufferDays: Math.min(60, Math.max(0, buffer)),
			...(perDay >= 1 ? { newPerDay: perDay } : {}),
		};
	}
	return out;
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

/** A course id from its name: lower-case ASCII words joined by dashes ("Medical Biology" → "medical-biology"). */
export function courseSlug(name: string): string {
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

export interface SuggestedPlan extends ImportPlan {
	/** Things the owner should know about the suggestion (never silent). */
	hints: string[];
}

/** Where a deck goes: a course (the subject) and, optionally, a topic inside it. */
export interface DeckPlacement {
	course: string;
	topic?: string;
}

export interface PlanOptions {
	/**
	 * Which deck level is the subject, i.e. the course: 0 = the top deck (the default), 1 = its first sub-deck, …
	 * What lies below that level is the topic: with 1, "1st Year::Biology::W1 Cell" becomes course "Biology", topic
	 * "W1 Cell". A deck that does not reach the level is its own course, without a topic.
	 */
	subjectLevel?: number;
	/** The owner's exception to the rule, per deck: another placement, or null to leave the deck out. */
	retarget?: (levels: readonly string[], placed: DeckPlacement) => DeckPlacement | null;
}

/** The rule for one deck (`levels` = its path, "1st Year::Biology::W1" → ["1st Year", "Biology", "W1"]). */
export function placeDeck(levels: readonly string[], subjectLevel = 0): DeckPlacement {
	const at = Math.min(Math.max(subjectLevel, 0), Math.max(levels.length - 1, 0));
	const topic = levels.slice(at + 1).join("::");
	return topic.length > 0 ? { course: levels[at] ?? "", topic } : { course: levels[at] ?? "" };
}

/** A starting point for the owner: by default the top-level deck = course, the rest = topic (see `PlanOptions` for
 *  another level); a course takes the (earliest) Deadline Scheduler deadline of its decks. */
export function suggestPlan(col: AnkiCollection, now: Date, options: PlanOptions = {}): SuggestedPlan {
	const place = (levels: readonly string[]): DeckPlacement | null => {
		const placed = placeDeck(levels, options.subjectLevel ?? 0);
		return options.retarget ? options.retarget(levels, placed) : placed;
	};
	const courses = new Map<string, StudyCourse>();
	const decks: ImportPlan["decks"] = {};
	for (const d of inspectCollection(col).decks) {
		const original = col.decks.find((x) => x.id === d.id);
		const placed = place(deckPath(original?.name ?? d.name));
		if (placed === null) {
			decks[String(d.id)] = null;
			continue;
		}
		const courseId = courseSlug(placed.course);
		if (!courses.has(courseId)) {
			courses.set(courseId, { id: courseId, name: placed.course, bufferDays: 5, createdAt: now.toISOString() });
		}
		decks[String(d.id)] = placed.topic ? { courseId, topic: placed.topic } : { courseId };
	}

	const hints: string[] = [];
	const found = new Map<string, AnkiSchedulerDeadline[]>();
	for (const [deckId, rec] of Object.entries(col.deadlines ?? {})) {
		const deck = col.decks.find((x) => String(x.id) === deckId);
		const placed = deck ? place(deckPath(deck.name)) : null;
		const courseId = placed === null ? undefined : courseSlug(placed.course);
		if (courseId === undefined || !courses.has(courseId)) continue;
		found.set(courseId, [...(found.get(courseId) ?? []), rec]);
	}
	for (const [courseId, recs] of found) {
		const course = courses.get(courseId)!;
		const earliest = [...recs].sort((a, b) => a.deadline.localeCompare(b.deadline))[0]!;
		course.deadline = earliest.deadline;
		course.bufferDays = earliest.bufferDays;
		// One per-day number belongs to ONE deck: with several decks in a course it is no number for the whole course,
		// so the pace stays automatic (what is left over the days to the deadline).
		const manyPerDay = recs.length > 1 && recs.some((r) => r.newPerDay !== undefined);
		if (earliest.newPerDay !== undefined && recs.length === 1) course.newPerDay = earliest.newPerDay;
		const distinct = [...new Set(recs.map((r) => r.deadline))].sort();
		const notes: string[] = [];
		if (distinct.length > 1) notes.push(`${distinct.length} decks have different Scheduler deadlines (${distinct.join(", ")}); using the earliest`);
		if (manyPerDay) notes.push("new cards per day left automatic (the Scheduler's per-deck numbers do not add up to a course)");
		if (notes.length > 0) hints.push(`${course.name}: ${notes.join("; ")}.`);
	}
	return { courses: [...courses.values()], decks, hints };
}

// ─── wire types (GET/POST /api/study/anki/*) ────────────────────────────────

export interface AnkiCandidate {
	/** The Anki profile folder's name, e.g. "Benutzer 1". */
	profile: string;
	path: string;
	sizeBytes: number;
	modified: string;
}

export interface MediaCopyResult {
	copied: string[];
	/** Referenced by a card but absent from the media folder. */
	missing: string[];
	/** Already present in the destination (kept as is). */
	existing: string[];
}

export interface InspectResult {
	inspection: AnkiInspection;
	/** A starting point for the deck → course mapping the owner edits. */
	suggestedPlan: SuggestedPlan;
	/** Courses already in the study store (valid targets, never altered). */
	existingCourses: { id: string; name: string }[];
}

export interface ImportOutcome {
	report: ImportReport;
	added: { courses: number; cards: number; reviews: number };
	alreadyImported: { cards: number; reviews: number };
	media: MediaCopyResult;
}

// ─── the plan arriving from the UI ──────────────────────────────────────────

/** The owner's plan was malformed (the UI should never send one; a stale or hand-made request can). */
export class ImportPlanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ImportPlanError";
	}
}

const COURSE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate a plan from the wire into a clean `ImportPlan`: course ids are
 * file-safe slugs, names non-empty, deadlines real dates, every deck points at
 * a course the import creates or that already exists. Throws ImportPlanError.
 */
export function parseImportPlan(raw: unknown, existingCourseIds: ReadonlySet<string>, now: Date): ImportPlan {
	const obj = (v: unknown, what: string): Record<string, unknown> => {
		if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ImportPlanError(`${what} must be an object`);
		return v as Record<string, unknown>;
	};
	const plan = obj(raw, "plan");
	if (!Array.isArray(plan.courses) || plan.courses.length > 200) throw new ImportPlanError("plan.courses must be a list");
	const courses: StudyCourse[] = [];
	const ids = new Set<string>();
	for (const entry of plan.courses) {
		const c = obj(entry, "course");
		const id = c.id;
		if (typeof id !== "string" || !COURSE_ID.test(id)) throw new ImportPlanError("course id must be letters, digits, - or _");
		if (ids.has(id)) throw new ImportPlanError(`duplicate course id ${id}`);
		ids.add(id);
		const name = typeof c.name === "string" ? c.name.trim() : "";
		if (name.length === 0 || name.length > 120) throw new ImportPlanError(`course ${id} needs a name`);
		if (c.deadline !== undefined && c.deadline !== null && !isoDay(c.deadline)) {
			throw new ImportPlanError(`course ${name}: deadline must be YYYY-MM-DD`);
		}
		const buffer = c.bufferDays === undefined ? 5 : c.bufferDays;
		if (typeof buffer !== "number" || !Number.isInteger(buffer) || buffer < 0 || buffer > 60) {
			throw new ImportPlanError(`course ${name}: buffer must be 0-60 days`);
		}
		const perDay = c.newPerDay;
		if (perDay !== undefined && perDay !== null && (typeof perDay !== "number" || !Number.isInteger(perDay) || perDay < 1 || perDay > 1000)) {
			throw new ImportPlanError(`course ${name}: new cards per day must be 1-1000`);
		}
		courses.push({
			id,
			name,
			...(typeof c.deadline === "string" ? { deadline: c.deadline } : {}),
			bufferDays: buffer,
			...(typeof perDay === "number" ? { newPerDay: perDay } : {}),
			createdAt: now.toISOString(),
		});
	}
	const decks: ImportPlan["decks"] = {};
	for (const [deckId, target] of Object.entries(obj(plan.decks, "plan.decks"))) {
		if (!/^\d+$/.test(deckId)) throw new ImportPlanError(`bad deck id ${deckId}`);
		if (target === null) {
			decks[deckId] = null;
			continue;
		}
		const t = obj(target, "deck target");
		const courseId = t.courseId;
		if (typeof courseId !== "string" || !(ids.has(courseId) || existingCourseIds.has(courseId))) {
			throw new ImportPlanError(`deck ${deckId} points at an unknown course`);
		}
		const topic = typeof t.topic === "string" ? t.topic.trim() : "";
		if (topic.length > 200) throw new ImportPlanError(`deck ${deckId}: topic is too long`);
		decks[deckId] = topic.length > 0 ? { courseId, topic } : { courseId };
	}
	return { courses, decks };
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
