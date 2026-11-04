/**
 * FSRS — the review-ledger fold (contracts/study.ts)
 *
 * Thin pure wrapper over `ts-fsrs` (the reference TypeScript implementation
 * of the algorithm Anki uses). A card's state is DERIVED: `replay` folds its
 * review lines in time order, so a parameter change re-derives every card.
 * Fuzz is off — the same ledger must always give the same schedule.
 */

import { Rating, createEmptyCard, fsrs, type Card, type Grade } from "ts-fsrs";
import type { StudyCardState, StudyGrade, StudyPhase, StudyReview } from "./contracts/study.ts";

export interface FsrsOptions {
	/** Target recall probability at review time, 0.7–0.97 (Anki default 0.9). */
	desiredRetention?: number;
	/** Longest interval in days (the Deadline Scheduler caps it below the deadline). */
	maximumInterval?: number;
}

const GRADE: Record<StudyGrade, Grade> = {
	1: Rating.Again,
	2: Rating.Hard,
	3: Rating.Good,
	4: Rating.Easy,
};

function scheduler(opts: FsrsOptions) {
	return fsrs({
		enable_fuzz: false,
		request_retention: opts.desiredRetention ?? 0.9,
		maximum_interval: opts.maximumInterval ?? 36500,
	});
}

function toCard(s: StudyCardState): Card {
	return {
		due: new Date(s.due),
		stability: s.stability,
		difficulty: s.difficulty,
		elapsed_days: 0,
		scheduled_days: s.scheduledDays,
		learning_steps: s.learningSteps,
		reps: s.reps,
		lapses: s.lapses,
		state: s.phase,
		last_review: s.lastReview ? new Date(s.lastReview) : undefined,
	} as Card;
}

function toState(cardId: string, c: Card): StudyCardState {
	return {
		cardId,
		phase: c.state as StudyPhase,
		due: c.due.toISOString(),
		stability: c.stability,
		difficulty: c.difficulty,
		scheduledDays: c.scheduled_days,
		reps: c.reps,
		lapses: c.lapses,
		lastReview: c.last_review?.toISOString(),
		learningSteps: c.learning_steps,
	};
}

/** The state of a card that was never reviewed: due at `now`. */
export function newCardState(cardId: string, now: Date): StudyCardState {
	return toState(cardId, createEmptyCard(now));
}

/** Apply one review to a state (null = a new card). */
export function applyReview(
	cardId: string,
	prev: StudyCardState | null,
	grade: StudyGrade,
	at: Date,
	opts: FsrsOptions = {},
): StudyCardState {
	const card = prev ? toCard(prev) : createEmptyCard(at);
	return toState(cardId, scheduler(opts).next(card, at, GRADE[grade]).card);
}

/** Fold a card's reviews (any order) into its current state; null = none. */
export function replay(
	cardId: string,
	reviews: readonly StudyReview[],
	opts: FsrsOptions = {},
): StudyCardState | null {
	const ordered = reviews
		.filter((r) => r.cardId === cardId)
		.sort((a, b) => a.at.localeCompare(b.at));
	let state: StudyCardState | null = null;
	for (const r of ordered) state = applyReview(cardId, state, r.grade, new Date(r.at), opts);
	return state;
}

/** Probability of recall at `now` (0 for a card never reviewed). */
export function retrievability(state: StudyCardState | null, now: Date): number {
	if (!state || !state.lastReview) return 0;
	return scheduler({}).retrievability(toCard(state), now);
}
