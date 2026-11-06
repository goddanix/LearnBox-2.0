/**
 * The .apkg export — the pure plan (Learnbox 2.0, 2026-11)
 *
 * Study cards, courses and the review ledger go in; the rows of an Anki 2.1 legacy package (schema 11: `col`, `notes`,
 * `cards`, `revlog`) come out as plain data. NO IO here: the SQLite file, the ZIP and the media copy live in
 * src/server/apkg-export.ts. Anki's own importer reads this layout in every version since 2.1 and recomputes what it
 * needs (field checksums, sort fields).
 *
 * How the study data maps:
 *  - course → deck (the topic → a sub-deck, unless the learner switches that off); a card keeps its deck path.
 *  - a NOTE is what Anki calls it: the cards of one Anki note, of one PDF/lesson draft (both directions, the gaps of
 *    one figure) share one note; any other card is a note of its own. Anki-imported cards keep their note and card ids.
 *  - the four note types are MedAnki's, verbatim (core/apkg-models.ts). Fields a note type does not have (a card carried
 *    over from a foreign Anki type) are folded into Extra / Explanation, never dropped.
 *  - Kernwissen: a `core` card gets the tag `MedAnki::Kernwissen` (the Deadline Scheduler's marker) if it lacks it.
 *  - progress OFF: every card arrives as a NEW card (only "suspended" is kept). progress ON: the review history goes
 *    into `revlog`, and the card's schedule as Learnbox shows it today (FSRS replay, the same `courseFsrsOptions` the
 *    queue uses) into the card row — due date, interval, lapses and, in `data`, FSRS stability/difficulty.
 *    A card buried until tomorrow is exported unburied (Anki unburies at the day change anyway).
 *
 * Deterministic: the same ledgers and the same `now` give the same plan (ids, guids and decks derive from the data).
 */

import { mediaRefs } from "./anki-import.ts";
import { ALL_MODELS, APKG_CSS, LATEX_POST, LATEX_PRE, MODEL_OF_KIND, type ApkgModel } from "./apkg-models.ts";
import type { StudyCard, StudyCardState, StudyCourse, StudyReview } from "./contracts/study.ts";
import { applyReview, type FsrsOptions } from "./fsrs.ts";
import { DAY_ROLLOVER_HOUR, addDays, courseFsrsOptions, groupReviews, localDay } from "./study-queue.ts";

export const CORE_TAG = "MedAnki::Kernwissen";

export interface ApkgOptions {
	/** Take the learner's progress along (review history, due dates, FSRS values); off = every card arrives as new. */
	progress: boolean;
	/** The topic of a card becomes a sub-deck of its course's deck. */
	subdecks: boolean;
}

export interface ApkgInput {
	/** The courses to export, in deck order. */
	courses: readonly StudyCourse[];
	/** Every card of the store (cards of other courses are ignored). */
	cards: readonly StudyCard[];
	/** The whole review ledger. */
	reviews: readonly StudyReview[];
	options: ApkgOptions;
	now: Date;
}

export interface ApkgDeck {
	id: number;
	name: string;
}
export interface ApkgNote {
	id: number;
	guid: string;
	/** The note type's id (core/apkg-models.ts). */
	mid: number;
	/** Seconds. */
	mod: number;
	tags: string[];
	fields: string[];
}
export interface ApkgCard {
	id: number;
	nid: number;
	did: number;
	ord: number;
	mod: number;
	type: 0 | 1 | 2 | 3;
	/** -1 suspended, 0 new, 1 learning, 2 review. */
	queue: -1 | 0 | 1 | 2;
	due: number;
	ivl: number;
	factor: number;
	reps: number;
	lapses: number;
	left: number;
	/** JSON; the FSRS memory state when the progress is taken along, else "". */
	data: string;
}
export interface ApkgRevlog {
	id: number;
	cid: number;
	ease: number;
	ivl: number;
	lastIvl: number;
	factor: number;
	time: number;
	type: 0 | 1 | 2;
}

export interface ApkgSummary {
	decks: number;
	notes: number;
	cards: number;
	reviews: number;
	/** Notes that carried fields the note type lacks (folded into Extra / Explanation). */
	foldedNotes: number;
}

/** What the export tells the learner when it is done (also the wire type of the response header). */
export interface ApkgExportSummary extends ApkgSummary {
	/** Media files packed into the package. */
	media: number;
	/** Referenced by a card but absent from the media folder — the package still imports, those pictures are empty (first 20 names). */
	missingMedia: string[];
	missingCount: number;
	/** Size of the package. */
	bytes: number;
}

export interface ApkgPlan {
	/** The collection's creation time, seconds (4 a.m. local of a day before everything in the package). */
	crt: number;
	/** The day `crt` stands for, "YYYY-MM-DD". */
	crtDay: string;
	/** Minutes west of UTC at `crt` (Anki's `creationOffset`). */
	minutesWest: number;
	decks: ApkgDeck[];
	notes: ApkgNote[];
	cards: ApkgCard[];
	revlog: ApkgRevlog[];
	/** The media files the exported fields reference (decoded names). */
	media: string[];
	summary: ApkgSummary;
}

// ─── small pure helpers ─────────────────────────────────────────────────────

const BASE91 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";

/** FNV-1a, 64 bit — a stable, dependency-free hash (core is browser-safe, so no node:crypto). */
function hash64(text: string): bigint {
	let h = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(text)) {
		h ^= BigInt(byte);
		h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return h;
}

/** Anki's guid alphabet (base 91) over a stable hash of `key`. */
export function guidFor(key: string): string {
	let n = hash64(key);
	let out = "";
	while (n > 0n) {
		out = BASE91[Number(n % 91n)] + out;
		n /= 91n;
	}
	return out || BASE91[0]!;
}

const dayNumber = (day: string): number => {
	const [y, m, d] = day.split("-").map(Number) as [number, number, number];
	return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};
const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

/** Local 4 a.m. of a study day, in epoch seconds. */
function rolloverOf(day: string): number {
	const [y, m, d] = day.split("-").map(Number) as [number, number, number];
	return Math.floor(new Date(y, m - 1, d, DAY_ROLLOVER_HOUR).getTime() / 1000);
}

const seconds = (ms: number): number => Math.floor(ms / 1000);
const isoMs = (iso: string, fallback: number): number => {
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : fallback;
};

/** One deck level: no control characters, no stray spaces; "" when nothing is left. */
function deckLevel(raw: string): string {
	// eslint-disable-next-line no-control-regex
	return raw.replace(/[\u0000-\u001f\u007f"]/g, " ").replace(/\s+/g, " ").trim();
}

/** "Anatomie" + "Arm::Nerven" → "Anatomie::Arm::Nerven"; empty levels are left out. */
export function deckNameOf(course: string, topic: string | undefined, subdecks: boolean): string {
	const levels = [course, ...(subdecks && topic ? topic.split("::") : [])].map(deckLevel).filter((l) => l.length > 0);
	return levels.length > 0 ? levels.join("::") : "Learnbox";
}

/** Anki tags cannot contain spaces. */
const cleanTag = (t: string): string => t.replace(/\s+/g, "_");

// ─── notes ──────────────────────────────────────────────────────────────────

/** The card's own note key: cards that share it are the cards of one Anki note. */
function noteKeyOf(card: StudyCard): string {
	const o = card.origin;
	if (o.kind === "anki-import") return `anki:${o.noteId}`;
	if ((o.kind === "pdf" || o.kind === "graph") && o.jobId && o.draftId) return `${o.kind}:${o.jobId}:${o.draftId}`;
	return `card:${card.id}`;
}

/** The Anki card number inside its note type: the template (basic) or the gap number minus one (cloze). */
function ordOf(card: StudyCard): number {
	return Math.max(0, Math.trunc(card.variant ?? 0));
}

const EXTRA_TARGET: Record<StudyCard["kind"], string> = { basic: "Extra", cloze: "Extra", occlusion: "Extra", mcq: "Explanation" };

/** Field values in the note type's order; fields it lacks are folded into Extra / Explanation. */
function fieldValues(model: ApkgModel, kind: StudyCard["kind"], fields: Readonly<Record<string, string>>): { values: string[]; folded: boolean } {
	const known = new Set(model.fields);
	const values = model.fields.map((name) => fields[name] ?? "");
	const extras = Object.entries(fields).filter(([name, value]) => !known.has(name) && value.trim().length > 0);
	if (extras.length === 0) return { values, folded: false };
	const at = model.fields.indexOf(EXTRA_TARGET[kind]);
	const folded = extras.map(([name, value]) => `<b>${name.replace(/[<>&]/g, "")}:</b> ${value}`).join("<br>");
	values[at] = values[at] ? `${values[at]}<br>${folded}` : folded;
	return { values, folded: true };
}

interface NoteGroup {
	key: string;
	cards: StudyCard[];
	usedOrds: Set<number>;
}

/** The cards of the selected courses as note groups, in ledger order. A card whose Anki card number the note already
 *  uses (or that the note type has no place for) becomes a note of its own. */
function groupNotes(cards: readonly StudyCard[]): NoteGroup[] {
	const groups = new Map<string, NoteGroup>();
	const order: NoteGroup[] = [];
	for (const card of cards) {
		const base = noteKeyOf(card);
		const ord = ordOf(card);
		const model = MODEL_OF_KIND[card.kind];
		const fits = model.type === 1 || ord < model.templates.length;
		let key = base;
		let group = groups.get(key);
		if (!fits || (group && group.usedOrds.has(ord)) || (group && group.cards[0]!.kind !== card.kind)) {
			key = `${base}#${card.id}`;
			group = groups.get(key);
		}
		if (!group) {
			group = { key, cards: [], usedOrds: new Set() };
			groups.set(key, group);
			order.push(group);
		}
		group.cards.push(card);
		group.usedOrds.add(fits ? ord : 0);
	}
	// the first card speaks for the note (its fields), so it is the one with the lowest card number
	for (const g of order) g.cards.sort((a, b) => ordOf(a) - ordOf(b));
	return order;
}

// ─── schedule ───────────────────────────────────────────────────────────────

/**
 * Anki reads the revlog of a legacy package in the OLD convention for learning and relearning answers: three buttons,
 * 1 Again / 2 Good / 3 Easy, and it lifts them to today's four (verified against Anki 26.09.3: 1→1, 2→3, 3→4, 4→4;
 * review answers pass unchanged). So Good is written as 2 and Easy as 3. The old convention has no Hard for learning
 * steps: a Hard answer there arrives as Good.
 */
const LEGACY_LEARN_EASE: Record<1 | 2 | 3 | 4, number> = { 1: 1, 2: 2, 3: 2, 4: 3 };

interface CardSchedule {
	type: ApkgCard["type"];
	queue: ApkgCard["queue"];
	due: number;
	ivl: number;
	factor: number;
	reps: number;
	lapses: number;
	left: number;
	data: string;
}

const NEW_SCHEDULE = (position: number): CardSchedule => ({ type: 0, queue: 0, due: position, ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, data: "" });

/** Interval as Anki's revlog writes it: days when positive, seconds (negative) while a card is in learning. */
function revlogInterval(state: StudyCardState, at: number): number {
	if (state.phase === 2 && state.scheduledDays >= 1) return state.scheduledDays;
	return -Math.max(1, Math.round((Date.parse(state.due) - at) / 1000));
}

function scheduleOf(state: StudyCardState, crtDay: string, opts: FsrsOptions): CardSchedule {
	const memory = JSON.stringify({
		s: Number(state.stability.toFixed(4)),
		d: Number(state.difficulty.toFixed(4)),
		dr: opts.desiredRetention ?? 0.9,
		...(state.lastReview ? { lrt: seconds(Date.parse(state.lastReview)) } : {}),
	});
	const base = { reps: state.reps, lapses: state.lapses, data: memory };
	if (state.phase === 2) {
		return { ...base, type: 2, queue: 2, due: daysBetween(crtDay, localDay(new Date(state.due))), ivl: Math.max(1, Math.round(state.scheduledDays)), factor: 2500, left: 0 };
	}
	// learning (1) or relearning (3): Anki wants the due moment in seconds; `left` = steps still to do (the default config has two)
	const remaining = Math.max(1, 2 - state.learningSteps);
	const left = remaining * 1000 + remaining;
	if (state.phase === 3) {
		return { ...base, type: 3, queue: 1, due: seconds(Date.parse(state.due)), ivl: Math.max(1, Math.round(state.stability)), factor: 2500, left };
	}
	if (state.phase === 1) return { ...base, type: 1, queue: 1, due: seconds(Date.parse(state.due)), ivl: 0, factor: 0, left };
	return { ...NEW_SCHEDULE(0), ...base };
}

// ─── the plan ───────────────────────────────────────────────────────────────

export function planApkg(input: ApkgInput): ApkgPlan {
	const { options } = input;
	const nowMs = input.now.getTime();
	const today = localDay(input.now);
	const courseById = new Map(input.courses.map((c) => [c.id, c]));
	const courseOrder = new Map(input.courses.map((c, i) => [c.id, i]));
	const chosen = input.cards
		.filter((c) => courseById.has(c.courseId))
		.map((c, index) => ({ c, index }))
		.sort((a, b) => courseOrder.get(a.c.courseId)! - courseOrder.get(b.c.courseId)! || a.index - b.index)
		.map(({ c }) => c);

	// what the learner has done, per card (undo pairs cancelled)
	const reviewsByCard = options.progress ? groupReviews(input.reviews) : new Map<string, StudyReview[]>();

	// 1. notes and cards, ids first (Anki-imported cards keep theirs)
	const groups = groupNotes(chosen);
	const takenNotes = new Set<number>();
	const takenCards = new Set<number>();
	const ankiCardId = (card: StudyCard): number | null => {
		const m = /^anki_(\d+)$/.exec(card.id);
		return m ? Number(m[1]) : null;
	};
	for (const g of groups) {
		const first = g.cards[0]!;
		if (first.origin.kind === "anki-import" && g.key === noteKeyOf(first)) takenNotes.add(first.origin.noteId);
		for (const c of g.cards) {
			const id = ankiCardId(c);
			if (id !== null) takenCards.add(id);
		}
	}
	const fresh = (taken: Set<number>, wish: number): number => {
		let id = wish;
		while (taken.has(id)) id++;
		taken.add(id);
		return id;
	};

	const decks = new Map<string, ApkgDeck>();
	const takenDecks = new Set<number>([1]);
	const deckFor = (name: string): number => {
		const known = decks.get(name);
		if (known) return known.id;
		let id = Number(hash64(`learnbox:${name}`) % 2_147_483_647n);
		while (id <= 1 || takenDecks.has(id)) id++;
		takenDecks.add(id);
		decks.set(name, { id, name });
		return id;
	};

	// new cards queue up Kernwissen first, like the review queue (core/study-queue.ts)
	const ranked = groups
		.map((g, index) => ({ g, index }))
		.sort((a, b) => Number(b.g.cards.some((c) => c.core)) - Number(a.g.cards.some((c) => c.core)) || a.index - b.index);
	const positionOf = new Map(ranked.map(({ g }, i) => [g, i + 1]));

	// the collection starts a day before everything in the package, so no due day is negative
	const days = [today];
	const walks = new Map<string, { states: StudyCardState[]; reviews: StudyReview[] }>();
	if (options.progress) {
		for (const card of chosen) {
			const reviews = reviewsByCard.get(card.id) ?? [];
			if (reviews.length === 0) continue;
			const course = courseById.get(card.courseId)!;
			const fsrsOpts = courseFsrsOptions(course, today);
			const states: StudyCardState[] = [];
			let prev: StudyCardState | null = null;
			for (const r of reviews) {
				prev = applyReview(card.id, prev, r.grade, new Date(r.at), fsrsOpts);
				states.push(prev);
			}
			walks.set(card.id, { states, reviews });
			days.push(localDay(new Date(reviews[0]!.at)));
			days.push(localDay(new Date(prev!.due)));
		}
	}
	const crtDay = addDays([...days].sort()[0]!, -1);
	const crt = rolloverOf(crtDay);
	const minutesWest = new Date(crt * 1000).getTimezoneOffset();

	const notes: ApkgNote[] = [];
	const cards: ApkgCard[] = [];
	const revlog: ApkgRevlog[] = [];
	const media = new Set<string>();
	const takenRevlog = new Set<number>();
	let foldedNotes = 0;

	for (const g of groups) {
		const rep = g.cards[0]!;
		const model = MODEL_OF_KIND[rep.kind];
		const { values, folded } = fieldValues(model, rep.kind, rep.fields);
		if (folded) foldedNotes++;
		// a reverse card needs the "Reverse" field filled, or Anki would find its front empty
		if (rep.kind === "basic" && g.cards.some((c) => ordOf(c) === 1) && values[model.fields.indexOf("Reverse")] === "") values[model.fields.indexOf("Reverse")] = "y";
		for (const f of mediaRefs(Object.fromEntries(model.fields.map((n, i) => [n, values[i]!])))) media.add(f);

		const tags = new Set<string>();
		for (const c of g.cards) for (const t of c.tags) if (cleanTag(t).length > 0) tags.add(cleanTag(t));
		if (g.cards.some((c) => c.core) && ![...tags].some((t) => t === CORE_TAG || t.startsWith(`${CORE_TAG}::`))) tags.add(CORE_TAG);

		const madeMs = Math.min(...g.cards.map((c) => isoMs(c.createdAt, nowMs)));
		const noteId = rep.origin.kind === "anki-import" && g.key === noteKeyOf(rep) ? rep.origin.noteId : fresh(takenNotes, madeMs);
		notes.push({ id: noteId, guid: guidFor(`learnbox__${g.key}`), mid: model.id, mod: seconds(madeMs), tags: [...tags], fields: values });

		for (const card of g.cards) {
			const course = courseById.get(card.courseId)!;
			const did = deckFor(deckNameOf(course.name, card.topic, options.subdecks));
			const cardId = ankiCardId(card) ?? fresh(takenCards, isoMs(card.createdAt, nowMs));
			const walk = walks.get(card.id);
			let schedule: CardSchedule = NEW_SCHEDULE(positionOf.get(g)!);
			if (walk) {
				schedule = scheduleOf(walk.states[walk.states.length - 1]!, crtDay, courseFsrsOptions(course, today));
				walk.reviews.forEach((r, i) => {
					const next = walk.states[i]!;
					const before: StudyCardState | null = i > 0 ? walk.states[i - 1]! : null;
					const at = Date.parse(r.at);
					const kind = before === null || before.phase < 2 ? 0 : before.phase === 2 ? 1 : 2;
					revlog.push({
						id: fresh(takenRevlog, at),
						cid: cardId,
						ease: kind === 1 ? r.grade : LEGACY_LEARN_EASE[r.grade],
						ivl: revlogInterval(next, at),
						lastIvl: before ? revlogInterval(before, Date.parse(before.lastReview ?? r.at)) : 0,
						factor: next.phase === 2 ? 2500 : 0,
						time: Math.max(0, Math.round(r.ms ?? 0)),
						type: kind,
					});
				});
			}
			cards.push({
				id: cardId,
				nid: noteId,
				did,
				ord: model.type === 1 ? ordOf(card) : Math.min(ordOf(card), model.templates.length - 1),
				mod: seconds(isoMs(card.createdAt, nowMs)),
				...schedule,
				queue: card.suspended ? -1 : schedule.queue,
			});
		}
	}

	return {
		crt,
		crtDay,
		minutesWest,
		decks: [...decks.values()],
		notes,
		cards,
		revlog,
		media: [...media].sort(),
		summary: { decks: decks.size, notes: notes.length, cards: cards.length, reviews: revlog.length, foldedNotes },
	};
}

// ─── the collection row (JSON columns) ──────────────────────────────────────

export interface ApkgCollectionJson {
	conf: string;
	models: string;
	decks: string;
	dconf: string;
}

/** The JSON columns of the `col` row — what genanki writes, with the models of this plan and its decks. */
export function collectionJson(plan: ApkgPlan, modSeconds: number): ApkgCollectionJson {
	const firstDeck = plan.decks[0]?.id ?? 1;
	const models: Record<string, unknown> = {};
	for (const m of ALL_MODELS) {
		models[String(m.id)] = {
			css: APKG_CSS,
			did: firstDeck,
			flds: m.fields.map((name, ord) => ({ name, ord, font: "Liberation Sans", media: [], rtl: false, size: 20, sticky: false })),
			id: String(m.id),
			latexPost: LATEX_POST,
			latexPre: LATEX_PRE,
			latexsvg: false,
			mod: modSeconds,
			name: m.name,
			req: m.req,
			sortf: 0,
			tags: [],
			tmpls: m.templates.map((t, ord) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt, ord, bafmt: "", bqfmt: "", bfont: "", bsize: 0, did: null })),
			type: m.type,
			usn: -1,
			vers: [],
		};
	}
	const deck = (id: number, name: string) => ({
		collapsed: false,
		conf: 1,
		desc: "",
		dyn: 0,
		extendNew: 0,
		extendRev: 50,
		id,
		lrnToday: [0, 0],
		mod: modSeconds,
		name,
		newToday: [0, 0],
		revToday: [0, 0],
		timeToday: [0, 0],
		usn: -1,
	});
	const decks: Record<string, unknown> = { "1": deck(1, "Default") };
	for (const d of plan.decks) decks[String(d.id)] = deck(d.id, d.name);
	const conf = {
		activeDecks: [1],
		addToCur: true,
		collapseTime: 1200,
		creationOffset: plan.minutesWest,
		curDeck: 1,
		curModel: String(ALL_MODELS[0]!.id),
		dueCounts: true,
		estTimes: true,
		newBury: true,
		newSpread: 0,
		nextPos: plan.notes.length + 1,
		rollover: DAY_ROLLOVER_HOUR,
		sortBackwards: false,
		sortType: "noteFld",
		timeLim: 0,
	};
	const dconf = {
		"1": {
			autoplay: true,
			id: 1,
			lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
			maxTaken: 60,
			mod: 0,
			name: "Default",
			new: { bury: true, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20, separate: true },
			replayq: true,
			rev: { bury: true, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 100 },
			timer: 0,
			usn: 0,
		},
	};
	return { conf: JSON.stringify(conf), models: JSON.stringify(models), decks: JSON.stringify(decks), dconf: JSON.stringify(dconf) };
}
