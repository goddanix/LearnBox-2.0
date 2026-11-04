import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StudyCard, StudyCourse, StudyReview } from "../src/core/contracts/study.ts";
import {
	DEFAULT_NEW_PER_DAY,
	buildQueue,
	clockAt,
	courseFsrsOptions,
	courseOverviews,
	formatDelay,
	groupReviews,
	localDay,
	pickNext,
	previewIntervals,
} from "../src/core/study-queue.ts";

const NOW = new Date(2026, 10, 4, 10, 0, 0); // 2026-11-04 10:00 local
const clock = clockAt(NOW);
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const course = (over: Partial<StudyCourse> = {}): StudyCourse => ({
	id: "k1",
	name: "Anatomie",
	bufferDays: 5,
	createdAt: "2026-10-01T00:00:00.000Z",
	...over,
});

let n = 0;
const card = (over: Partial<StudyCard> = {}): StudyCard => ({
	id: `c${++n}`,
	courseId: "k1",
	kind: "basic",
	fields: { Front: "f", Back: "b" },
	tags: [],
	core: false,
	origin: { kind: "manual" },
	createdAt: "2026-10-01T00:00:00.000Z",
	...over,
});

const review = (cardId: string, at: Date, grade: 1 | 2 | 3 | 4 = 3): StudyReview => ({
	cardId,
	at: at.toISOString(),
	grade,
});

const queueOf = (c: StudyCourse, cards: StudyCard[], reviews: StudyReview[] = []) =>
	buildQueue(c, cards, groupReviews(reviews), clock);

describe("study queue", () => {
	it("localDay formats the local calendar date", () => {
		assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
		assert.equal(clock.today, "2026-11-04");
	});

	it("without a deadline: default quota, core first, only the course's live cards", () => {
		const cards = [
			...Array.from({ length: 30 }, () => card()),
			card({ core: true }),
			card({ courseId: "other" }),
			card({ suspended: true }),
		];
		const q = queueOf(course(), cards);
		assert.equal(q.newQuota, DEFAULT_NEW_PER_DAY);
		assert.equal(q.new.length, DEFAULT_NEW_PER_DAY);
		assert.equal(q.new[0]?.card.core, true);
		assert.equal(q.total, 31);
		assert.equal(q.unseen, 31);
		assert.equal(q.daysLeft, null);
	});

	it("a manual newPerDay wins", () => {
		const q = queueOf(course({ newPerDay: 3 }), Array.from({ length: 10 }, () => card()));
		assert.equal(q.new.length, 3);
	});

	it("deadline quota = ceil(remaining / (daysLeft - buffer)), fixed for the day", () => {
		const cards = Array.from({ length: 100 }, () => card());
		// 20 days left, 5 buffer → 15 days → ceil(100/15) = 7
		const c = course({ deadline: "2026-11-24" });
		const q = queueOf(c, cards);
		assert.equal(q.daysLeft, 20);
		assert.equal(q.newQuota, 7);
		// after introducing 3 today: remaining 97 + 3 introduced = 100 → quota unchanged, 4 left
		const reviews = cards.slice(0, 3).map((x) => review(x.id, minutes(-30)));
		const q2 = queueOf(c, cards, reviews);
		assert.equal(q2.introducedToday, 3);
		assert.equal(q2.newQuota, 7);
		assert.equal(q2.new.length, 4);
	});

	it("an expired deadline (buffer included) falls back to the default quota", () => {
		const q = queueOf(course({ deadline: "2026-10-20" }), Array.from({ length: 40 }, () => card()));
		assert.equal(q.daysLeft, null);
		assert.equal(q.newQuota, DEFAULT_NEW_PER_DAY);
	});

	it("caps intervals below the deadline and boosts retention shortly before it", () => {
		assert.deepEqual(courseFsrsOptions(course(), "2026-11-04"), {});
		const far = courseFsrsOptions(course({ deadline: "2027-03-01" }), "2026-11-04");
		assert.equal(far.maximumInterval, 116);
		assert.equal(far.desiredRetention, 0.9);
		const near = courseFsrsOptions(course({ deadline: "2026-11-08" }), "2026-11-04");
		assert.equal(near.maximumInterval, 3);
		assert.ok((near.desiredRetention ?? 0) > 0.9);
	});

	it("sorts reviews into learning (due now / ahead), review (due today) and not-due", () => {
		const a = card(); // reviewed 1 day ago, Good ×1 → learning step due 10 min later (past)
		const b = card(); // Again just now → due in ~1 minute → learn ahead
		const cards = [a, b];
		const reviews = [review(a.id, minutes(-60 * 24)), review(b.id, NOW, 1)];
		const q = queueOf(course(), cards, reviews);
		assert.equal(q.learning.length, 1);
		assert.equal(q.learning[0]?.card.id, a.id);
		assert.equal(q.learnAhead.length, 1);
		assert.equal(q.learnAhead[0]?.card.id, b.id);
		assert.equal(q.counts.learning, 2);
	});

	it("a graduated card is in review once its day has come, not before", () => {
		const a = card();
		// two Goods a day apart, long ago → graduated, interval far shorter than 300 days → overdue
		const history = [review(a.id, days(-400)), review(a.id, days(-399))];
		const overdue = queueOf(course(), [a], history);
		assert.equal(overdue.review.length, 1);
		assert.equal(overdue.review[0]?.state?.phase, 2);
		assert.equal(overdue.counts.review, 1);
		// an Easy five minutes ago pushes it past today
		const done = queueOf(course(), [a], [...history, review(a.id, minutes(-5), 4)]);
		assert.equal(done.review.length, 0);
	});

	it("pattern: new, new, learning — and falls back when a kind is empty", () => {
		const learn1 = card();
		const learn2 = card();
		const fresh = Array.from({ length: 4 }, () => card());
		const reviews = [review(learn1.id, minutes(-60 * 3)), review(learn2.id, minutes(-60 * 3))];
		const q = queueOf(course(), [learn1, learn2, ...fresh], reviews);
		assert.equal(q.learning.length, 2);
		assert.equal(pickNext(q, 0)?.bucket, "new");
		assert.equal(pickNext(q, 1)?.bucket, "new");
		assert.equal(pickNext(q, 2)?.bucket, "learning");
		assert.equal(pickNext(q, 3)?.bucket, "new");

		const onlyLearning = queueOf(course(), [learn1], [review(learn1.id, minutes(-60 * 3))]);
		assert.equal(pickNext(onlyLearning, 0)?.bucket, "learning"); // wanted new is empty → learning
		const nothing = queueOf(course(), []);
		assert.equal(pickNext(nothing, 0), null);
	});

	it("learn-ahead cards are the last resort", () => {
		const b = card();
		const q = queueOf(course(), [b], [review(b.id, NOW, 1)]);
		assert.equal(q.learning.length, 0);
		assert.equal(pickNext(q, 0)?.card.id, b.id);
	});

	it("course overviews count per course", () => {
		const cards = [card(), card(), card({ courseId: "k2" })];
		const out = courseOverviews([course(), course({ id: "k2", name: "Physio" })], cards, [], clock);
		assert.deepEqual(
			out.map((o) => [o.course.id, o.counts.new, o.total]),
			[
				["k1", 2, 2],
				["k2", 1, 1],
			],
		);
	});

	it("formats delays like Anki's buttons", () => {
		assert.equal(formatDelay(30_000), "<1m");
		assert.equal(formatDelay(10 * 60_000), "10m");
		assert.equal(formatDelay(3 * 3_600_000), "3h");
		assert.equal(formatDelay(4 * 86_400_000), "4d");
		assert.equal(formatDelay(45 * 86_400_000), "1.5mo");
		assert.equal(formatDelay(800 * 86_400_000), "2.2y");
	});

	it("previews an interval for every grade, growing from Again to Easy", () => {
		const a = card();
		const q = queueOf(course(), [a]);
		const item = pickNext(q, 0)!;
		const labels = previewIntervals(item, q, NOW);
		assert.deepEqual(Object.keys(labels), ["1", "2", "3", "4"]);
		assert.equal(labels[1], "1m");
		assert.match(labels[4], /d$/); // Easy graduates to days
	});
});
