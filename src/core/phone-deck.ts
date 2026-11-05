/**
 * The phone's deck (Learnbox 2.0, Slice 10c): what the Mac cuts for a phone, and how a phone reads it back. Pure —
 * the Mac side (server/phone-deck.ts) supplies the ledgers and the media sizes, the phone side (components/mobile)
 * supplies what it already holds.
 */

import { PHONE_DECK_SCHEMA } from "./contracts/mobile.ts";
import type { PhoneDeck, PhoneMediaEntry } from "./contracts/mobile.ts";
import type { StudyReview } from "./contracts/study.ts";
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

/**
 * Cut a deck. `mediaSize` says how big a media file is on the Mac, or null when it is not there (a card that points
 * at a missing file shows the same "missing" on the phone as on the Mac, so such names are left out). `reviewsFrom`
 * is how many ledger lines the phone already has.
 */
export function buildPhoneDeck(store: StudyStore, mediaSize: (name: string) => number | null, reviewsFrom: number, now: Date): PhoneDeck {
	const cards = store.readCards();
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
		courses: store.readCourses(),
		cards,
		reviewsFrom: from,
		reviews: all.slice(from),
		reviewsTotal: all.length,
		media,
	};
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
	return raw as unknown as PhoneDeck;
}
