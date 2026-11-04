/**
 * Deadline math — the Deadline Scheduler add-on's pure rules, ported
 *
 * No IO, no Anki. Core idea (unchanged): there is NO fixed plan. The quota of
 * new cards per day is recomputed from what is still unlearned, so skipped
 * days spread themselves over the remaining ones. The pre-exam practice deck
 * is deliberately not ported (the owner switched it off).
 */

export const MIN_RETENTION = 0.7;
export const MAX_RETENTION = 0.97;

const DAY_MS = 86_400_000;

/** Days from `today` to `deadline` (both "YYYY-MM-DD"); 0 = exam day, negative = past. */
export function daysUntil(deadline: string, today: string): number {
	return Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/** Days on which NEW cards are still introduced (the rest is a review-only buffer); at least 1. */
export function effectiveNewCardWindow(daysLeft: number, bufferDays: number): number {
	return Math.max(1, daysLeft - bufferDays);
}

/** New cards due today so that all remaining ones are introduced before the buffer starts. */
export function newCardsPerDay(remainingNew: number, daysLeft: number, bufferDays: number): number {
	const remaining = Math.max(0, Math.trunc(remainingNew));
	if (remaining === 0) return 0;
	return Math.ceil(remaining / effectiveNewCardWindow(daysLeft, bufferDays));
}

/** The manual quota when set (at least 1), else the automatic one. */
export function effectiveQuota(autoQuota: number, override?: number | null): number {
	if (override === undefined || override === null) return Math.max(0, Math.trunc(autoQuota));
	return Math.max(1, Math.trunc(override));
}

/** Days until all remaining new cards are introduced at this quota. */
export function daysToFinish(remainingNew: number, quota: number): number {
	if (remainingNew <= 0) return 0;
	return Math.ceil(remainingNew / Math.max(1, quota));
}

/** Cap for the maximum review interval: never due past the deadline, at least 1 day. */
export function maxIntervalDays(daysLeft: number): number {
	return Math.max(1, daysLeft - 1);
}

/** Warning for an unrealistic daily load. */
export function exceedsThreshold(cardsPerDay: number, threshold: number): boolean {
	return cardsPerDay > threshold;
}

/** Share of passed reviews (anything but Again) in percent, one decimal. */
export function retentionRate(passed: number, total: number): number {
	if (total <= 0) return 0;
	const p = Math.max(0, Math.min(passed, total));
	return Math.round((p / total) * 1000) / 10;
}

/** Share of cards learned at least once, in percent, one decimal. */
export function percentLearned(totalCards: number, remainingNew: number): number {
	if (totalCards <= 0) return 0;
	const r = Math.max(0, Math.min(remainingNew, totalCards));
	return Math.round(((totalCards - r) / totalCards) * 1000) / 10;
}

/** Least-loaded buffer day (ties → the earlier one), so no spike builds on the last day. */
export function pickBufferDay(dayLoad: readonly number[]): number {
	if (dayLoad.length === 0) throw new Error("buffer has no days");
	let best = 0;
	for (let i = 1; i < dayLoad.length; i++) if ((dayLoad[i] ?? 0) < (dayLoad[best] ?? 0)) best = i;
	return best;
}

/** `nCards` buffer-day indices (0 = first buffer day), spread evenly. */
export function distributeBufferDueDates(nCards: number, bufferDays: number): number[] {
	const load = new Array<number>(Math.max(1, bufferDays)).fill(0);
	const out: number[] = [];
	for (let n = Math.max(0, nCards); n > 0; n--) {
		const i = pickBufferDay(load);
		load[i] = (load[i] ?? 0) + 1;
		out.push(i);
	}
	return out;
}

/**
 * A card whose target due day (`dueDaysLeft`, days from today) falls on or
 * after the deadline is moved into the buffer, spread by `dayLoad` (one cell
 * per buffer day, buffer start → deadline). Earlier due days stay unchanged.
 */
export function compressedDueOffset(
	dueDaysLeft: number,
	daysLeft: number,
	bufferDays: number,
	dayLoad: readonly number[],
): number {
	const bufferStart = Math.max(0, daysLeft - bufferDays);
	if (dueDaysLeft <= bufferStart) return dueDaysLeft;
	if (dueDaysLeft < daysLeft) return dueDaysLeft;
	const load = dayLoad.length > 0 ? dayLoad : new Array<number>(Math.max(1, bufferDays)).fill(0);
	return bufferStart + pickBufferDay(load);
}

/** Slightly raise the target retention in the last `window` days (off unless the caller asks). */
export function boostedRetention(base: number, daysLeft: number, window = 7, amount = 0.03): number {
	const b = Math.max(MIN_RETENTION, Math.min(MAX_RETENTION, base));
	if (daysLeft > window) return b;
	return Math.round(Math.min(MAX_RETENTION, b + amount) * 10_000) / 10_000;
}
