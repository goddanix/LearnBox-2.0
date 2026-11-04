/**
 * Study queue — what to review next in one course
 *
 * PURE: cards + review ledger + a clock in, the next card out. Nothing is
 * stored; the whole queue is re-derived from the ledgers on every call (a
 * card's FSRS state is a fold of its reviews, see fsrs.ts), so the browser
 * only has to carry a step counter.
 *
 * Rules, ported from the Anki add-ons the user ran:
 *  - one course per session, courses are never mixed;
 *  - Deadline Scheduler: with an active deadline the new cards per day are
 *    ceil(remaining / (daysLeft - buffer)), recomputed from what is still
 *    unlearned (the day's quota is fixed at day start: remaining + introduced
 *    today); core-knowledge cards are introduced before the rest; reviews are
 *    capped below the deadline and retention is boosted shortly before it;
 *  - StudyQueueOrder: the pattern new, new, "again" (a card in learning) —
 *    when the wanted kind is empty the order is learning, new, review (the
 *    deadline decks ran with "new cards first").
 */

import type {
	StudyCard,
	StudyCardState,
	StudyCourse,
	StudyGrade,
	StudyQueueCounts,
	StudyReview,
} from "./contracts/study.ts";
import { boostedRetention, daysUntil, effectiveQuota, maxIntervalDays, newCardsPerDay } from "./deadline.ts";
import { effectiveReviews, previewGrades, replay, type FsrsOptions } from "./fsrs.ts";

/** New cards per day for a course without an (active) deadline or override. */
export const DEFAULT_NEW_PER_DAY = 20;
/** A card in learning that is due within this many minutes may be shown early when nothing else is left. */
export const LEARN_AHEAD_MINUTES = 20;
/** The StudyQueueOrder pattern, repeated forever. */
export const QUEUE_PATTERN = ["new", "new", "learning"] as const;

export type QueueBucket = "new" | "learning" | "review";

export interface QueueClock {
	now: Date;
	/** The study day of `now`, "YYYY-MM-DD" (the day rolls over at DAY_ROLLOVER_HOUR). */
	today: string;
}

/** The study day ends at 04:00 local time, like Anki: whoever learns after midnight is still in the same day. */
export const DAY_ROLLOVER_HOUR = 4;

const pad = (n: number): string => String(n).padStart(2, "0");
const fmt = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local midnight of the study day that contains `d`. */
function studyDate(d: Date): Date {
	const day = d.getHours() < DAY_ROLLOVER_HOUR ? d.getDate() - 1 : d.getDate();
	return new Date(d.getFullYear(), d.getMonth(), day);
}

/** The study day "YYYY-MM-DD" of a moment. */
export function localDay(d: Date): string {
	return fmt(studyDate(d));
}

/** A study day plus `n` days ("2026-11-04", 1 → "2026-11-05"). */
export function addDays(day: string, n: number): string {
	const [y, m, d] = day.split("-").map(Number) as [number, number, number];
	return fmt(new Date(y, m - 1, d + n));
}

/** The clock for a moment (local time zone of the runtime). */
export function clockAt(now: Date): QueueClock {
	return { now, today: localDay(now) };
}

/** The last millisecond of the study day containing `d`. */
function endOfStudyDay(d: Date): Date {
	const s = studyDate(d);
	return new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1, DAY_ROLLOVER_HOUR, 0, 0, -1);
}

export interface QueueItem {
	card: StudyCard;
	/** Derived FSRS state; null = never reviewed. */
	state: StudyCardState | null;
	bucket: QueueBucket;
}

export type QueueCounts = StudyQueueCounts;

export interface CourseQueue {
	course: StudyCourse;
	/** Learning / relearning cards due now, oldest first. */
	learning: QueueItem[];
	/** Learning cards due within the learn-ahead window (shown only when nothing else is left). */
	learnAhead: QueueItem[];
	/** Review cards due by the end of today, most overdue first. */
	review: QueueItem[];
	/** Today's new cards still to introduce: core first, then card order. */
	new: QueueItem[];
	counts: QueueCounts;
	/** New cards already introduced today / today's quota. */
	introducedToday: number;
	newQuota: number;
	/** Live (unsuspended) cards of the course. */
	total: number;
	/** Unseen cards in total (not just today's share). */
	unseen: number;
	/** Days to the deadline when one is active, else null. */
	daysLeft: number | null;
	fsrs: FsrsOptions;
}

/** Reviews by card, undo pairs already cancelled (see effectiveReviews). */
export function groupReviews(reviews: readonly StudyReview[]): Map<string, StudyReview[]> {
	const raw = new Map<string, StudyReview[]>();
	for (const r of reviews) {
		const list = raw.get(r.cardId);
		if (list) list.push(r);
		else raw.set(r.cardId, [r]);
	}
	return new Map([...raw].map(([id, list]) => [id, effectiveReviews(list)]));
}

/** Days left while the deadline (buffer included) has not passed; null otherwise. */
function activeDaysLeft(course: StudyCourse, today: string): number | null {
	if (!course.deadline) return null;
	const left = daysUntil(course.deadline, today);
	return left < -course.bufferDays ? null : left;
}

/** FSRS options of a course today: intervals capped below the deadline, retention boosted near it. */
export function courseFsrsOptions(course: StudyCourse, today: string): FsrsOptions {
	const left = activeDaysLeft(course, today);
	if (left === null) return {};
	return { desiredRetention: boostedRetention(0.9, left), maximumInterval: maxIntervalDays(left) };
}

/** Build one course's queue from the full ledgers (cards of other courses are ignored). */
export function buildQueue(
	course: StudyCourse,
	cards: readonly StudyCard[],
	reviewsByCard: ReadonlyMap<string, readonly StudyReview[]>,
	clock: QueueClock,
): CourseQueue {
	const fsrsOpts = courseFsrsOptions(course, clock.today);
	const dueNow = clock.now.getTime();
	const aheadUntil = dueNow + LEARN_AHEAD_MINUTES * 60_000;
	const dayEnd = endOfStudyDay(clock.now).getTime();

	const learning: QueueItem[] = [];
	const learnAhead: QueueItem[] = [];
	const review: QueueItem[] = [];
	const unseenCards: StudyCard[] = [];
	let total = 0;
	let introducedToday = 0;

	for (const card of cards) {
		if (card.courseId !== course.id || card.suspended) continue;
		total++;
		const reviews = reviewsByCard.get(card.id);
		const state = reviews && reviews.length > 0 ? replay(card.id, reviews, fsrsOpts) : null;
		if (!state) {
			unseenCards.push(card);
			continue;
		}
		const first = reviews!.reduce((min, r) => (r.at < min ? r.at : min), reviews![0]!.at);
		if (localDay(new Date(first)) === clock.today) introducedToday++;
		// a buried card is counted but not offered until its day
		if (card.buriedUntil && card.buriedUntil > clock.today) continue;
		const due = Date.parse(state.due);
		if (state.phase === 1 || state.phase === 3) {
			if (due <= dueNow) learning.push({ card, state, bucket: "learning" });
			else if (due <= aheadUntil) learnAhead.push({ card, state, bucket: "learning" });
		} else if (state.phase === 2 && due <= dayEnd) {
			review.push({ card, state, bucket: "review" });
		}
	}

	const byDue = (a: QueueItem, b: QueueItem) => Date.parse(a.state!.due) - Date.parse(b.state!.due);
	learning.sort(byDue);
	learnAhead.sort(byDue);
	review.sort(byDue);

	const left = activeDaysLeft(course, clock.today);
	const unseen = unseenCards.length;
	const newQuota =
		left === null
			? (course.newPerDay ?? DEFAULT_NEW_PER_DAY)
			: effectiveQuota(newCardsPerDay(unseen + introducedToday, left, course.bufferDays), course.newPerDay);
	const todaysNew = Math.max(0, newQuota - introducedToday);
	// core knowledge first; Array#sort is stable, so card order holds within each group
	const newItems = unseenCards
		.filter((card) => !(card.buriedUntil && card.buriedUntil > clock.today))
		.map((card): QueueItem => ({ card, state: null, bucket: "new" }))
		.sort((a, b) => Number(b.card.core) - Number(a.card.core))
		.slice(0, todaysNew);

	return {
		course,
		learning,
		learnAhead,
		review,
		new: newItems,
		counts: {
			new: newItems.length,
			learning: learning.length + learnAhead.length,
			review: review.length,
		},
		introducedToday,
		newQuota,
		total,
		unseen,
		daysLeft: left,
		fsrs: fsrsOpts,
	};
}

/** A specific card as a queue item, wherever it stands (undo and edit show a card the queue would not pick). */
export function itemForCard(
	card: StudyCard,
	reviewsByCard: ReadonlyMap<string, readonly StudyReview[]>,
	fsrs: FsrsOptions,
): QueueItem {
	const reviews = reviewsByCard.get(card.id);
	const state = reviews && reviews.length > 0 ? replay(card.id, reviews, fsrs) : null;
	const bucket: QueueBucket = !state ? "new" : state.phase === 2 ? "review" : "learning";
	return { card, state, bucket };
}

/** The next card for step `step` (0 = first card of the session), or null when the course is done for today. */
export function pickNext(queue: CourseQueue, step: number): QueueItem | null {
	const wanted = QUEUE_PATTERN[Math.abs(Math.trunc(step)) % QUEUE_PATTERN.length]!;
	const lists: Record<QueueBucket, QueueItem[]> = {
		new: queue.new,
		learning: queue.learning,
		review: queue.review,
	};
	const preferred = lists[wanted][0];
	if (preferred) return preferred;
	for (const bucket of ["learning", "new", "review"] as const) {
		if (bucket === wanted) continue;
		const item = lists[bucket][0];
		if (item) return item;
	}
	return queue.learnAhead[0] ?? null;
}

export interface CourseOverview {
	course: StudyCourse;
	counts: QueueCounts;
	total: number;
	newQuota: number;
	daysLeft: number | null;
}

/** Counts per course for the "which course?" screen. */
export function courseOverviews(
	courses: readonly StudyCourse[],
	cards: readonly StudyCard[],
	reviews: readonly StudyReview[],
	clock: QueueClock,
): CourseOverview[] {
	const byCard = groupReviews(reviews);
	return courses.map((course) => {
		const q = buildQueue(course, cards, byCard, clock);
		return { course, counts: q.counts, total: q.total, newQuota: q.newQuota, daysLeft: q.daysLeft };
	});
}

// ─── interval preview under the answer buttons ───────────────────────────────

/** "10m", "3h", "4d", "1.2mo", "2.1y" — Anki's button labels. */
export function formatDelay(ms: number): string {
	const trim = (n: number) => String(Math.round(n * 10) / 10);
	const minutes = ms / 60_000;
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${Math.round(minutes)}m`;
	const hours = minutes / 60;
	if (hours < 24) return `${Math.round(hours)}h`;
	const days = hours / 24;
	if (days < 30) return `${Math.round(days)}d`;
	if (days < 365) return `${trim(days / 30)}mo`;
	return `${trim(days / 365)}y`;
}

/** Label per grade for a card shown now. */
export function previewIntervals(item: QueueItem, queue: CourseQueue, now: Date): Record<StudyGrade, string> {
	const states = previewGrades(item.card.id, item.state, now, queue.fsrs);
	const label = (g: StudyGrade) => formatDelay(Date.parse(states[g].due) - now.getTime());
	return { 1: label(1), 2: label(2), 3: label(3), 4: label(4) };
}
