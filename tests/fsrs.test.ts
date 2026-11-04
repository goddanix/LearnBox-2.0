import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyReview, effectiveReviews, newCardState, replay, retrievability } from "../src/core/fsrs.ts";
import type { StudyReview } from "../src/core/contracts/study.ts";

const T0 = new Date("2026-11-04T08:00:00Z");
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

describe("FSRS review-ledger fold", () => {
	it("a new card is due immediately and unreviewed", () => {
		const s = newCardState("c1", T0);
		assert.equal(s.phase, 0);
		assert.equal(s.reps, 0);
		assert.equal(s.due, T0.toISOString());
	});

	it("Good on a new card enters learning with a due time after review", () => {
		const s = applyReview("c1", null, 3, T0);
		assert.equal(s.reps, 1);
		assert.ok(new Date(s.due) > T0);
		assert.equal(s.lastReview, T0.toISOString());
	});

	it("is deterministic: replaying the same ledger gives the same state", () => {
		const reviews: StudyReview[] = [
			{ cardId: "c1", at: T0.toISOString(), grade: 3 },
			{ cardId: "c1", at: day(1).toISOString(), grade: 3 },
			{ cardId: "c1", at: day(5).toISOString(), grade: 1 },
		];
		const a = replay("c1", reviews);
		const b = replay("c1", [...reviews].reverse());
		assert.deepEqual(a, b);
		assert.equal(a?.reps, 3);
		assert.ok((a?.lapses ?? 0) >= 1);
	});

	it("ignores other cards' reviews and returns null for an unreviewed card", () => {
		const reviews: StudyReview[] = [{ cardId: "other", at: T0.toISOString(), grade: 3 }];
		assert.equal(replay("c1", reviews), null);
	});

	it("caps the interval by the maximum interval option", () => {
		let s = applyReview("c1", null, 4, T0, { maximumInterval: 3 });
		for (let i = 1; i <= 6; i++) s = applyReview("c1", s, 4, new Date(s.due), { maximumInterval: 3 });
		assert.ok(s.scheduledDays <= 3, `scheduledDays ${s.scheduledDays}`);
	});

	it("retrievability falls over time and is 0 for an unreviewed card", () => {
		const s = applyReview("c1", null, 3, T0);
		const soon = retrievability(s, day(1));
		const late = retrievability(s, day(60));
		assert.ok(soon > late);
		assert.equal(retrievability(null, T0), 0);
	});

	it("an undo line cancels the latest earlier review — the ledger only grows", () => {
		const r1: StudyReview = { cardId: "c1", at: T0.toISOString(), grade: 3 };
		const r2: StudyReview = { cardId: "c1", at: day(1).toISOString(), grade: 1 };
		const undo2: StudyReview = { cardId: "c1", at: day(1.5).toISOString(), grade: 1, undo: true };
		assert.deepEqual(effectiveReviews([r1, r2, undo2]), [r1]);
		assert.deepEqual(replay("c1", [r1, r2, undo2]), replay("c1", [r1]));
		// the undone answer can be given again, and a second undo reaches further back
		const r3: StudyReview = { cardId: "c1", at: day(2).toISOString(), grade: 4 };
		const undo3: StudyReview = { cardId: "c1", at: day(2.5).toISOString(), grade: 4, undo: true };
		const undo1: StudyReview = { cardId: "c1", at: day(3).toISOString(), grade: 3, undo: true };
		assert.deepEqual(effectiveReviews([r1, r2, undo2, r3]), [r1, r3]);
		assert.deepEqual(effectiveReviews([r1, r2, undo2, r3, undo3, undo1]), []);
		// undoing a card's only review makes it unseen again
		assert.equal(replay("c1", [r1, { ...undo1, at: day(0.5).toISOString() }]), null);
	});

	it("an undo with nothing before it changes nothing", () => {
		assert.deepEqual(effectiveReviews([{ cardId: "c1", at: T0.toISOString(), grade: 3, undo: true }]), []);
	});
});
