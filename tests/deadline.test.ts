import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	boostedRetention,
	compressedDueOffset,
	daysToFinish,
	daysUntil,
	distributeBufferDueDates,
	effectiveNewCardWindow,
	effectiveQuota,
	maxIntervalDays,
	newCardsPerDay,
	percentLearned,
	pickBufferDay,
	retentionRate,
} from "../src/core/deadline.ts";

describe("deadline math (ported from the Deadline Scheduler add-on)", () => {
	it("counts days between calendar dates, negative when past", () => {
		assert.equal(daysUntil("2026-11-14", "2026-11-04"), 10);
		assert.equal(daysUntil("2026-11-04", "2026-11-04"), 0);
		assert.equal(daysUntil("2026-11-01", "2026-11-04"), -3);
	});

	it("keeps at least one day for new cards, even past the deadline", () => {
		assert.equal(effectiveNewCardWindow(10, 5), 5);
		assert.equal(effectiveNewCardWindow(3, 5), 1);
		assert.equal(effectiveNewCardWindow(-2, 5), 1);
	});

	it("spreads the remaining new cards over the new-card window, rounding up", () => {
		assert.equal(newCardsPerDay(100, 25, 5), 5);
		assert.equal(newCardsPerDay(101, 25, 5), 6);
		assert.equal(newCardsPerDay(0, 25, 5), 0);
		assert.equal(newCardsPerDay(40, 2, 5), 40);
	});

	it("takes the manual quota when set, never below 1; zero auto stays zero", () => {
		assert.equal(effectiveQuota(12, undefined), 12);
		assert.equal(effectiveQuota(12, 0), 1);
		assert.equal(effectiveQuota(12, 30), 30);
		assert.equal(effectiveQuota(0, null), 0);
	});

	it("computes days to finish and the interval cap", () => {
		assert.equal(daysToFinish(0, 5), 0);
		assert.equal(daysToFinish(11, 5), 3);
		assert.equal(maxIntervalDays(10), 9);
		assert.equal(maxIntervalDays(1), 1);
		assert.equal(maxIntervalDays(-4), 1);
	});

	it("computes percentages with one decimal", () => {
		assert.equal(retentionRate(0, 0), 0);
		assert.equal(retentionRate(2, 3), 66.7);
		assert.equal(percentLearned(0, 0), 0);
		assert.equal(percentLearned(8, 2), 75);
	});

	it("picks the least-loaded buffer day, ties to the earlier", () => {
		assert.equal(pickBufferDay([3, 1, 1, 2]), 1);
		assert.equal(pickBufferDay([0, 0]), 0);
		assert.throws(() => pickBufferDay([]));
		assert.deepEqual(distributeBufferDueDates(5, 3), [0, 1, 2, 0, 1]);
	});

	it("moves due dates past the deadline into the buffer, leaves earlier ones alone", () => {
		// deadline in 10 days, buffer 5 → buffer starts at day 5
		assert.equal(compressedDueOffset(3, 10, 5, [0, 0, 0, 0, 0]), 3);
		assert.equal(compressedDueOffset(5, 10, 5, [0, 0, 0, 0, 0]), 5);
		assert.equal(compressedDueOffset(8, 10, 5, [0, 0, 0, 0, 0]), 8);
		assert.equal(compressedDueOffset(12, 10, 5, [2, 2, 0, 3, 3]), 7);
		assert.equal(compressedDueOffset(12, 10, 5, []), 5);
	});

	it("boosts retention only in the last week and caps it", () => {
		assert.equal(boostedRetention(0.9, 20), 0.9);
		assert.equal(boostedRetention(0.9, 7), 0.93);
		assert.equal(boostedRetention(0.96, 3), 0.97);
		assert.equal(boostedRetention(0.5, 30), 0.7);
	});
});
