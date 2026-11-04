/**
 * StudyStore adapter tests (src/store/study.ts) — courses/cards as
 * last-line-wins upserts with tombstones, reviews as pure appends.
 * Runs against a throw-away temp dir through createStudyStore(files); it
 * never touches data/study.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { StudyCard, StudyCourse, StudyReview } from "../src/core/contracts.ts";
import { replay } from "../src/core/fsrs.ts";
import { createStudyStore, type StudyFiles } from "../src/store/study.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "study-store-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
let files: StudyFiles;
beforeEach(() => {
	const dir = path.join(root, `case${++n}`);
	files = {
		courses: path.join(dir, "courses.jsonl"),
		cards: path.join(dir, "cards.jsonl"),
		reviews: path.join(dir, "reviews.jsonl"),
	};
});

const course = (id: string, over: Partial<StudyCourse> = {}): StudyCourse => ({
	id,
	name: `Course ${id}`,
	bufferDays: 5,
	createdAt: "2026-11-04T08:00:00.000Z",
	...over,
});

const card = (id: string, over: Partial<StudyCard> = {}): StudyCard => ({
	id,
	courseId: "anatomy",
	kind: "basic",
	fields: { Front: "Q", Back: "A" },
	tags: [],
	core: false,
	origin: { kind: "manual" },
	createdAt: "2026-11-04T08:00:00.000Z",
	...over,
});

const review = (cardId: string, at: string, grade: StudyReview["grade"]): StudyReview => ({ cardId, at, grade });

describe("study store", () => {
	it("reads empty ledgers as empty lists", () => {
		const s = createStudyStore(files);
		assert.deepEqual(s.readCourses(), []);
		assert.deepEqual(s.readCards(), []);
		assert.deepEqual(s.readReviews(), []);
	});

	it("round-trips a course and a card", () => {
		const s = createStudyStore(files);
		const c = course("anatomy", { deadline: "2026-12-01", newPerDay: 10 });
		const k = card("c1", { topic: "Arm", origin: { kind: "pdf", jobId: "j1", page: 3 } });
		s.upsertCourse(c);
		s.upsertCard(k);
		assert.deepEqual(s.readCourses(), [c]);
		assert.deepEqual(s.readCards(), [k]);
	});

	it("last line wins and keeps first-appearance order", () => {
		const s = createStudyStore(files);
		s.upsertCard(card("a"));
		s.upsertCard(card("b"));
		s.upsertCard(card("a", { suspended: true, tags: ["x"] }));
		const cards = s.readCards();
		assert.deepEqual(cards.map((c) => c.id), ["a", "b"]);
		assert.equal(cards[0]?.suspended, true);
		assert.deepEqual(cards[0]?.tags, ["x"]);
	});

	it("keeps the tier of a card and skips a card with a tier outside 1-3", () => {
		const s = createStudyStore(files);
		s.upsertCards([card("t1", { tier: 1 }), card("t3", { tier: 3 }), card("none")]);
		fs.appendFileSync(files.cards, `${JSON.stringify({ ...card("bad"), tier: 4 })}\n`);
		const read = s.readCards();
		assert.deepEqual(read.map((c) => [c.id, c.tier]), [["t1", 1], ["t3", 3], ["none", undefined]]);
	});

	it("a tombstone removes a record and a later upsert revives it", () => {
		const s = createStudyStore(files);
		s.upsertCourse(course("a"));
		s.upsertCourse(course("b"));
		s.removeCourse("a");
		assert.deepEqual(s.readCourses().map((c) => c.id), ["b"]);
		s.upsertCourse(course("a", { name: "Back" }));
		assert.deepEqual(s.readCourses().map((c) => c.name), ["Back", "Course b"]);
		s.upsertCard(card("c1"));
		s.removeCard("c1");
		assert.deepEqual(s.readCards(), []);
	});

	it("appends batches in one go and keeps review order", () => {
		const s = createStudyStore(files);
		s.upsertCards([card("a"), card("b"), card("c")]);
		s.appendReviews([review("a", "2026-11-04T08:00:00.000Z", 3), review("b", "2026-11-04T08:01:00.000Z", 1)]);
		s.appendReview(review("a", "2026-11-05T08:00:00.000Z", 4));
		assert.equal(s.readCards().length, 3);
		assert.deepEqual(s.readReviews().map((r) => `${r.cardId}${r.grade}`), ["a3", "b1", "a4"]);
		s.appendReviews([]);
		assert.equal(s.readReviews().length, 3);
	});

	it("skips torn, foreign and invalid lines without failing the read", () => {
		const s = createStudyStore(files);
		s.upsertCard(card("good"));
		fs.appendFileSync(files.cards, '{"id":"torn","courseId"\n');
		fs.appendFileSync(files.cards, `${JSON.stringify({ id: "bad", courseId: "x", kind: "weird", fields: {}, tags: [], core: false, origin: { kind: "manual" }, createdAt: "t" })}\n`);
		fs.appendFileSync(files.cards, "not json at all\n");
		s.appendReview(review("good", "2026-11-04T08:00:00.000Z", 3));
		fs.appendFileSync(files.reviews, `${JSON.stringify({ cardId: "good", at: "t", grade: 9 })}\n`);
		assert.deepEqual(s.readCards().map((c) => c.id), ["good"]);
		assert.equal(s.readReviews().length, 1);
	});

	it("an invalid later line does not overwrite the valid earlier record", () => {
		const s = createStudyStore(files);
		s.upsertCard(card("a", { tags: ["keep"] }));
		fs.appendFileSync(files.cards, `${JSON.stringify({ id: "a", courseId: 7 })}\n`);
		assert.deepEqual(s.readCards()[0]?.tags, ["keep"]);
	});

	it("feeds the FSRS fold: the stored ledger re-derives the same schedule", () => {
		const s = createStudyStore(files);
		s.upsertCard(card("a"));
		s.appendReviews([
			review("a", "2026-11-04T08:00:00.000Z", 3),
			review("a", "2026-11-05T08:00:00.000Z", 3),
			review("b", "2026-11-05T09:00:00.000Z", 1),
		]);
		const state = replay("a", s.readReviews());
		assert.equal(state?.reps, 2);
		assert.deepEqual(state, replay("a", s.readReviews()));
	});
});
