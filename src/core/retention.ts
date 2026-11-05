/**
 * How well a subject was remembered lately (Learnbox 2.0, 2026-11). MedAnki asked the Deadline Scheduler add-on for the
 * retention of a subject's closed deadlines; Learnbox has no such reports, so the number comes from the review ledger
 * itself: the share of answers that were not "Again" over the last weeks, like the add-on's own count (every answer
 * counts, learning steps too). A subject that was remembered badly gets somewhat more core-knowledge cards from its
 * next PDF (agent/create/card-prompts.ts retentionHint).
 */

import { retentionRate } from "./deadline.ts";
import { effectiveReviews } from "./fsrs.ts";
import type { StudyReview } from "./contracts/study.ts";

/** Below this (percent) a subject counts as remembered badly. */
export const LOW_RETENTION_THRESHOLD = 80;
/** Only the answers of this many days count. */
export const RETENTION_WINDOW_DAYS = 60;
/** Fewer answers than this say too little. */
export const MIN_RETENTION_REVIEWS = 40;

export interface CourseRetention {
	/** Answers counted. */
	reviews: number;
	/** Percent of them that were not "Again", one decimal. */
	retention: number;
}

/** The retention of the given cards (a subject's) over the last `RETENTION_WINDOW_DAYS`, or null with too few answers. */
export function courseRetention(reviews: readonly StudyReview[], cardIds: ReadonlySet<string>, now: Date): CourseRetention | null {
	const since = new Date(now.getTime() - RETENTION_WINDOW_DAYS * 86_400_000).toISOString();
	const byCard = new Map<string, StudyReview[]>();
	for (const r of reviews) {
		if (!cardIds.has(r.cardId)) continue;
		const list = byCard.get(r.cardId);
		if (list) list.push(r);
		else byCard.set(r.cardId, [r]);
	}
	let total = 0;
	let passed = 0;
	for (const list of byCard.values()) {
		for (const r of effectiveReviews(list)) {
			if (r.at < since || r.at > now.toISOString()) continue;
			total++;
			if (r.grade > 1) passed++;
		}
	}
	return total < MIN_RETENTION_REVIEWS ? null : { reviews: total, retention: retentionRate(passed, total) };
}
