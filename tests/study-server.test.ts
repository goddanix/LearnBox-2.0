/**
 * The review screen's server functions (src/server/study.ts) against a
 * throw-away store + media folder — never data/study.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { StudyCard, StudyCourse } from "../src/core/contracts/study.ts";
import { StudyInputError, mediaResolver, studyAnswer, studyCourses, studyNext, type StudyDeps } from "../src/server/study.ts";
import { createStudyStore } from "../src/store/study.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "study-server-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const NOW = new Date(2026, 10, 4, 10, 0, 0);

function setup(): { deps: StudyDeps; cards: StudyCard[] } {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const store = createStudyStore({
		courses: path.join(dir, "courses.jsonl"),
		cards: path.join(dir, "cards.jsonl"),
		reviews: path.join(dir, "reviews.jsonl"),
	});
	const mediaDir = path.join(dir, "media");
	fs.mkdirSync(mediaDir);
	fs.writeFileSync(path.join(mediaDir, "arm.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	const course: StudyCourse = { id: "k1", name: "Anatomie", bufferDays: 5, createdAt: NOW.toISOString() };
	store.upsertCourse(course);
	store.upsertCourse({ id: "k2", name: "Leer", bufferDays: 5, createdAt: NOW.toISOString() });
	const cards: StudyCard[] = [
		{
			id: "a",
			courseId: "k1",
			kind: "basic",
			fields: { Front: "Q-a", Back: "A-a" },
			tags: [],
			core: false,
			origin: { kind: "manual" },
			createdAt: NOW.toISOString(),
		},
		{
			id: "b",
			courseId: "k1",
			kind: "basic",
			fields: { Front: '<img src="arm.png">Q-b', Back: "A-b" },
			tags: ["MedAnki::Kernwissen"],
			core: true,
			origin: { kind: "manual" },
			createdAt: NOW.toISOString(),
		},
	];
	store.upsertCards(cards);
	return { deps: { store, mediaDir }, cards };
}

describe("study server", () => {
	it("lists courses with counts", () => {
		const { deps } = setup();
		const out = studyCourses(NOW, deps);
		assert.deepEqual(
			out.map((c) => [c.id, c.counts.new, c.total]),
			[
				["k1", 2, 2],
				["k2", 0, 0],
			],
		);
	});

	it("serves core cards first, with media inlined and intervals for all grades", () => {
		const { deps } = setup();
		const r = studyNext("k1", 0, NOW, deps);
		assert.equal(r.card?.id, "b");
		assert.equal(r.card?.core, true);
		assert.match(r.card?.front ?? "", /src="data:image\/png;base64,/);
		assert.match(r.card?.back ?? "", /A-b/);
		assert.equal(r.card?.intervals[1], "1m");
		assert.deepEqual(r.counts, { new: 2, learning: 0, review: 0 });
	});

	it("answering writes the review and moves on; Again keeps the card coming back", () => {
		const { deps } = setup();
		const first = studyNext("k1", 0, NOW, deps);
		const after1 = studyAnswer({ courseId: "k1", cardId: first.card!.id, grade: 1, ms: 1500, step: 0 }, NOW, deps);
		const reviews = deps.store.readReviews();
		assert.equal(reviews.length, 1);
		assert.equal(reviews[0]?.grade, 1);
		assert.equal(reviews[0]?.ms, 1500);
		assert.equal(after1.step, 1);
		assert.equal(after1.card?.id, "a"); // the other new card; "b" waits in learning
		assert.equal(after1.counts.learning, 1);
		const after2 = studyAnswer({ courseId: "k1", cardId: "a", grade: 4, step: 1 }, NOW, deps);
		assert.equal(after2.card?.id, "b"); // only the learn-ahead card is left
		assert.equal(after2.step, 2);
	});

	it("a finished course returns card null", () => {
		const { deps } = setup();
		assert.equal(studyNext("k2", 0, NOW, deps).card, null);
	});

	it("rejects unknown courses/cards and bad grades", () => {
		const { deps } = setup();
		assert.throws(() => studyNext("nope", 0, NOW, deps), (e) => e instanceof StudyInputError && e.status === 404);
		assert.throws(() => studyAnswer({ courseId: "k1", cardId: "zzz", grade: 3 }, NOW, deps), StudyInputError);
		assert.throws(
			() => studyAnswer({ courseId: "k2", cardId: "a", grade: 3 }, NOW, deps),
			(e) => e instanceof StudyInputError && e.status === 404,
		);
		assert.throws(
			() => studyAnswer({ courseId: "k1", cardId: "a", grade: 7 }, NOW, deps),
			(e) => e instanceof StudyInputError && e.status === 400,
		);
		assert.equal(deps.store.readReviews().length, 0);
	});

	it("the media resolver serves bare image/audio names only", () => {
		const { deps } = setup();
		fs.writeFileSync(path.join(deps.mediaDir, "note.txt"), "x");
		fs.writeFileSync(path.join(deps.mediaDir, ".hidden.png"), "x");
		const resolve = mediaResolver(deps.mediaDir);
		assert.match(resolve("arm.png") ?? "", /^data:image\/png;base64,/);
		assert.equal(resolve("../arm.png"), null);
		assert.equal(resolve("sub/arm.png"), null);
		assert.equal(resolve(".hidden.png"), null);
		assert.equal(resolve("note.txt"), null);
		assert.equal(resolve("missing.png"), null);
	});
});
