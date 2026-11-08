/**
 * The phone's deck (Learnbox 2.0, Slice 10c): what the Mac cuts for a phone, and how a phone reads it back. Pure —
 * the Mac side (server/phone-deck.ts) supplies the ledgers and the media sizes, the phone side (components/mobile)
 * supplies what it already holds.
 */

import { PHONE_DECK_SCHEMA } from "./contracts/mobile.ts";
import type { PhoneCatalog, PhoneCatalogEntry, PhoneCatalogTopic, PhoneDeck, PhoneMediaEntry, PhoneTopicChoice } from "./contracts/mobile.ts";
import type { StudyCard, StudyReview } from "./contracts/study.ts";
import type { StudyStore } from "./ports.ts";
import { mediaNamesOf } from "./study-render.ts";

/** A review's identity: the same answer given once, wherever copies of it travel (the phone, the Mac, a backup file). */
export const reviewKey = (r: StudyReview): string => `${r.cardId}|${r.at}|${r.grade}|${r.undo ? 1 : 0}`;

/** Lines of `incoming` that `known` does not hold yet, each once, in order. */
export function newReviews(known: Iterable<StudyReview>, incoming: readonly StudyReview[]): StudyReview[] {
	const seen = new Set<string>();
	for (const r of known) seen.add(reviewKey(r));
	const out: StudyReview[] = [];
	for (const r of incoming) {
		const key = reviewKey(r);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(r);
	}
	return out;
}

/** The most courses a request may name (a phone has nowhere near this many; the cap only bounds the address). */
const MAX_COURSE_IDS = 200;

/**
 * The `courses` query value of a deck request: a comma-separated list of course ids. Absent = every course
 * (`undefined`); present but empty = none (`[]`); a list that cannot be one (too long, empty or huge ids) is `null`.
 */
export function readCourseIds(param: string | null): string[] | undefined | null {
	if (param === null) return undefined;
	if (param === "") return [];
	const ids = param.split(",");
	if (ids.length > MAX_COURSE_IDS || ids.some((id) => id === "" || id.length > 120)) return null;
	return [...new Set(ids)];
}

/** The subdeck name of a card: its topic, or the empty name for a card that has none. */
export const topicNameOf = (card: Pick<StudyCard, "topic">): string => card.topic ?? "";

/** Limits on a subdeck choice (a phone has a few dozen subdecks; the caps only bound the address and the storage). */
const MAX_CHOICE_COURSES = 200;
const MAX_CHOICE_NAMES = 2000;
const MAX_TOPIC_NAME = 300;

/** A subdeck choice read off the wire or out of the phone's storage: course id → distinct topic names. Anything else is null. */
export function cleanTopicChoice(raw: unknown): PhoneTopicChoice | null {
	if (!isRecord(raw)) return null;
	const entries = Object.entries(raw);
	if (entries.length > MAX_CHOICE_COURSES) return null;
	const out = new Map<string, string[]>();
	let names = 0;
	for (const [id, list] of entries) {
		if (id === "" || id.length > 120 || !Array.isArray(list)) return null;
		if (!list.every((n) => typeof n === "string" && n.length <= MAX_TOPIC_NAME)) return null;
		const distinct = [...new Set(list as string[])];
		names += distinct.length;
		if (names > MAX_CHOICE_NAMES) return null;
		out.set(id, distinct);
	}
	return Object.fromEntries(out);
}

/**
 * The `topics` query value of a deck request: the subdeck choice as JSON ({"course-id": ["W1", ""]}). Absent = every
 * subdeck of every chosen course (`undefined`); a value that cannot be a choice is `null`.
 */
export function readTopicChoice(param: string | null): PhoneTopicChoice | undefined | null {
	if (param === null) return undefined;
	if (param.length > 200_000) return null;
	try {
		return cleanTopicChoice(JSON.parse(param) as unknown);
	} catch {
		return null;
	}
}

/** The subdecks held of one course, or null when the course is held whole. */
export function topicsHeld(choice: Readonly<PhoneTopicChoice> | undefined, courseId: string): readonly string[] | null {
	if (!choice || !Object.prototype.hasOwnProperty.call(choice, courseId)) return null;
	return choice[courseId] ?? null;
}

/** Is this card in the choice? A card of a course held whole is; of a course held in part, when its subdeck is listed. */
function inChoice(card: StudyCard, choice: Readonly<PhoneTopicChoice> | undefined): boolean {
	const held = topicsHeld(choice, card.courseId);
	return held === null || held.includes(topicNameOf(card));
}

/** Subdeck names in the order the learner reads them: numbers as numbers ("W2" before "W10"), no subdeck last. */
const byTopicName = (a: string, b: string): number => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

/** Bytes of the media the given cards use, counting each file once. */
function mediaBytes(cards: readonly StudyCard[], mediaSize: (name: string) => number | null): number {
	const seen = new Set<string>();
	let total = 0;
	for (const card of cards) {
		for (const name of mediaNamesOf(card)) {
			if (seen.has(name)) continue;
			seen.add(name);
			total += mediaSize(name) ?? 0;
		}
	}
	return total;
}

/** Every course with what taking it would put on a phone. */
export function buildPhoneCatalog(store: StudyStore, mediaSize: (name: string) => number | null): PhoneCatalogEntry[] {
	const cards = store.readCards();
	return store.readCourses().map((c) => {
		const own = cards.filter((card) => card.courseId === c.id);
		const byTopic = new Map<string, StudyCard[]>();
		for (const card of own) byTopic.set(topicNameOf(card), [...(byTopic.get(topicNameOf(card)) ?? []), card]);
		const topics: PhoneCatalogTopic[] = [...byTopic.keys()]
			.sort(byTopicName)
			.map((name) => ({ name, cards: byTopic.get(name)!.length, mediaBytes: mediaBytes(byTopic.get(name)!, mediaSize) }));
		return { id: c.id, name: c.name, cards: own.length, mediaBytes: mediaBytes(own, mediaSize), topics };
	});
}

/**
 * Cut a deck. `mediaSize` says how big a media file is on the Mac, or null when it is not there (a card that points
 * at a missing file shows the same "missing" on the phone as on the Mac, so such names are left out). `reviewsFrom`
 * is how many ledger lines the phone already has. `courseIds` are the courses the phone chose (all when absent): the
 * deck holds only their cards, the review lines of those cards and the media they use; `reviewsTotal` stays the whole
 * ledger's length, because that is the position the phone asks from next time. `topicChoice` narrows a course to some of
 * its subdecks (Slice 10h); a course it does not name comes whole.
 */
export function buildPhoneDeck(
	store: StudyStore,
	mediaSize: (name: string) => number | null,
	reviewsFrom: number,
	now: Date,
	courseIds?: readonly string[],
	topicChoice?: Readonly<PhoneTopicChoice>,
): PhoneDeck {
	const chosen = courseIds ? new Set(courseIds) : null;
	const cards = store.readCards().filter((c) => (!chosen || chosen.has(c.courseId)) && inChoice(c, topicChoice));
	const ids = new Set(cards.map((c) => c.id));
	const all = store.readReviews();
	const from = Number.isInteger(reviewsFrom) && reviewsFrom >= 0 && reviewsFrom <= all.length ? reviewsFrom : 0;
	const names = new Set<string>();
	for (const card of cards) for (const name of mediaNamesOf(card)) names.add(name);
	const media: PhoneMediaEntry[] = [];
	for (const name of [...names].sort()) {
		const size = mediaSize(name);
		if (size !== null) media.push({ name, size });
	}
	return {
		v: PHONE_DECK_SCHEMA,
		at: now.toISOString(),
		courses: store.readCourses().filter((c) => !chosen || chosen.has(c.id)),
		cards,
		reviewsFrom: from,
		reviews: chosen || topicChoice ? all.slice(from).filter((r) => ids.has(r.cardId)) : all.slice(from),
		reviewsTotal: all.length,
		media,
		catalog: buildPhoneCatalog(store, mediaSize),
	};
}

/** The catalog as the phone gets it. */
export function phoneCatalogOf(store: StudyStore, mediaSize: (name: string) => number | null): PhoneCatalog {
	return { v: PHONE_DECK_SCHEMA, courses: buildPhoneCatalog(store, mediaSize) };
}

/** A catalog read off the wire (or out of the phone's meta): the shape is checked, anything else is null. */
export function readPhoneCatalogEntries(raw: unknown): PhoneCatalogEntry[] | null {
	if (!Array.isArray(raw)) return null;
	const out: PhoneCatalogEntry[] = [];
	for (const e of raw) {
		if (!isRecord(e) || typeof e.id !== "string" || typeof e.name !== "string") return null;
		if (typeof e.cards !== "number" || !Number.isFinite(e.cards) || typeof e.mediaBytes !== "number" || !Number.isFinite(e.mediaBytes)) return null;
		const entry: PhoneCatalogEntry = { id: e.id, name: e.name, cards: e.cards, mediaBytes: e.mediaBytes };
		if (e.topics !== undefined) {
			const topics = readCatalogTopics(e.topics);
			if (!topics) return null;
			entry.topics = topics;
		}
		out.push(entry);
	}
	return out;
}

function readCatalogTopics(raw: unknown): PhoneCatalogTopic[] | null {
	if (!Array.isArray(raw)) return null;
	const out: PhoneCatalogTopic[] = [];
	const seen = new Set<string>();
	for (const t of raw) {
		if (!isRecord(t) || typeof t.name !== "string" || t.name.length > MAX_TOPIC_NAME || seen.has(t.name)) return null;
		if (typeof t.cards !== "number" || !Number.isFinite(t.cards) || typeof t.mediaBytes !== "number" || !Number.isFinite(t.mediaBytes)) return null;
		seen.add(t.name);
		out.push({ name: t.name, cards: t.cards, mediaBytes: t.mediaBytes });
	}
	return out;
}

/** GET /api/phone/catalog read back. */
export function readPhoneCatalog(raw: unknown): PhoneCatalogEntry[] | null {
	return isRecord(raw) && raw.v === PHONE_DECK_SCHEMA ? readPhoneCatalogEntries(raw.courses) : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A deck read off the wire: the shape is checked, nothing is guessed — anything else is not a deck. */
export function readPhoneDeck(raw: unknown): PhoneDeck | null {
	if (!isRecord(raw) || raw.v !== PHONE_DECK_SCHEMA || typeof raw.at !== "string") return null;
	const { courses, cards, reviews, media, reviewsFrom, reviewsTotal } = raw;
	if (!Array.isArray(courses) || !Array.isArray(cards) || !Array.isArray(reviews) || !Array.isArray(media)) return null;
	if (!Number.isInteger(reviewsFrom) || !Number.isInteger(reviewsTotal) || (reviewsFrom as number) < 0 || (reviewsTotal as number) < (reviewsFrom as number) + reviews.length) return null;
	if (!courses.every((c) => isRecord(c) && typeof c.id === "string" && typeof c.name === "string")) return null;
	if (!cards.every((c) => isRecord(c) && typeof c.id === "string" && typeof c.courseId === "string" && isRecord(c.fields))) return null;
	if (!reviews.every((r) => isRecord(r) && typeof r.cardId === "string" && typeof r.at === "string" && [1, 2, 3, 4].includes(r.grade as number))) return null;
	if (!media.every((m) => isRecord(m) && typeof m.name === "string" && typeof m.size === "number")) return null;
	if (raw.catalog !== undefined && readPhoneCatalogEntries(raw.catalog) === null) return null;
	return raw as unknown as PhoneDeck;
}
