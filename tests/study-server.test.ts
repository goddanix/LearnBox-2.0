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
import {
	StudyInputError,
	createStudyCourse,
	mediaResolver,
	studyAnswer,
	studyCardAction,
	studyCourses,
	studyNext,
	studyUndo,
	type StudyDeps,
} from "../src/server/study.ts";
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

	it("undo appends a compensating line and shows the card again at its step", () => {
		const { deps } = setup();
		const first = studyNext("k1", 0, NOW, deps);
		const answered = studyAnswer({ courseId: "k1", cardId: first.card!.id, grade: 1, step: 0 }, NOW, deps);
		assert.equal(answered.counts.learning, 1);
		const later = new Date(NOW.getTime() + 5_000);
		const back = studyUndo({ courseId: "k1", cardId: first.card!.id, step: 0 }, later, deps);
		// nothing was rewritten: the ledger holds the answer and its undo
		const lines = deps.store.readReviews();
		assert.equal(lines.length, 2);
		assert.equal(lines[1]?.undo, true);
		assert.equal(lines[1]?.grade, 1);
		assert.equal(back.card?.id, first.card!.id);
		assert.equal(back.card?.bucket, "new");
		assert.equal(back.step, 0);
		assert.deepEqual(back.counts, { new: 2, learning: 0, review: 0 });
		// the card can be answered again, and undone again
		studyAnswer({ courseId: "k1", cardId: first.card!.id, grade: 3, step: 0 }, later, deps);
		studyUndo({ courseId: "k1", cardId: first.card!.id, step: 0 }, later, deps);
		assert.equal(studyNext("k1", 0, later, deps).counts.new, 2);
	});

	it("undo with nothing to undo (or a clock behind the review) is refused or ordered correctly", () => {
		const { deps } = setup();
		assert.throws(
			() => studyUndo({ courseId: "k1", cardId: "a" }, NOW, deps),
			(e) => e instanceof StudyInputError && e.status === 400,
		);
		assert.throws(() => studyUndo({ courseId: "k1", cardId: "zzz" }, NOW, deps), StudyInputError);
		studyAnswer({ courseId: "k1", cardId: "a", grade: 3 }, NOW, deps);
		const behind = new Date(NOW.getTime() - 60_000);
		studyUndo({ courseId: "k1", cardId: "a" }, behind, deps);
		const [review, undo] = deps.store.readReviews();
		assert.ok(undo!.at > review!.at);
		assert.equal(studyNext("k1", 0, NOW, deps).counts.new, 2);
	});

	it("suspend removes the card from the queue, unsuspend brings it back and shows it", () => {
		const { deps } = setup();
		const out = studyCardAction({ courseId: "k1", cardId: "b", action: "suspend", step: 0 }, NOW, deps);
		assert.equal(out.card?.id, "a");
		assert.equal(out.counts.new, 1);
		assert.equal(studyCourses(NOW, deps)[0]?.total, 1);
		const back = studyCardAction({ courseId: "k1", cardId: "b", action: "unsuspend", step: 0 }, NOW, deps);
		assert.equal(back.card?.id, "b");
		assert.equal(back.counts.new, 2);
		assert.equal(deps.store.readCards().find((c) => c.id === "b")?.suspended, undefined);
	});

	it("bury hides the card for the rest of the study day only", () => {
		const { deps } = setup();
		const out = studyCardAction({ courseId: "k1", cardId: "b", action: "bury", step: 0 }, NOW, deps);
		assert.equal(out.card?.id, "a");
		assert.equal(deps.store.readCards().find((c) => c.id === "b")?.buriedUntil, "2026-11-05");
		assert.equal(studyNext("k1", 0, new Date(2026, 10, 5, 3, 0), deps).counts.new, 1); // still the same study day
		assert.equal(studyNext("k1", 0, new Date(2026, 10, 5, 4, 30), deps).counts.new, 2);
		const back = studyCardAction({ courseId: "k1", cardId: "b", action: "unbury", step: 0 }, NOW, deps);
		assert.equal(back.card?.id, "b");
		assert.equal(deps.store.readCards().find((c) => c.id === "b")?.buriedUntil, undefined);
	});

	it("editing changes the card and every card of the same Anki note, nothing else", () => {
		const { deps } = setup();
		const mk = (id: string, noteId: number, variant: number): StudyCard => ({
			id,
			courseId: "k1",
			kind: "cloze",
			fields: { Text: "{{c1::x}} {{c2::y}}", Extra: "" },
			tags: [],
			core: false,
			origin: { kind: "anki-import", noteId },
			variant,
			createdAt: NOW.toISOString(),
		});
		deps.store.upsertCards([mk("n1-0", 100, 0), mk("n1-1", 100, 1), mk("n2-0", 200, 0)]);
		const shown = studyCardAction(
			{ courseId: "k1", cardId: "n1-0", action: "edit", fields: { Text: "{{c1::x2}} {{c2::y}}" }, step: 3 },
			NOW,
			deps,
		);
		assert.equal(shown.card?.id, "n1-0");
		assert.equal(shown.step, 3);
		assert.equal(shown.card?.siblings, 1);
		assert.equal(shown.card?.fields.Text, "{{c1::x2}} {{c2::y}}");
		const byId = new Map(deps.store.readCards().map((c) => [c.id, c]));
		assert.equal(byId.get("n1-1")?.fields.Text, "{{c1::x2}} {{c2::y}}");
		assert.equal(byId.get("n1-1")?.fields.Extra, "");
		assert.equal(byId.get("n2-0")?.fields.Text, "{{c1::x}} {{c2::y}}");
		assert.equal(byId.get("a")?.fields.Front, "Q-a");
		// a manual card has no siblings: only itself changes
		const manual = studyCardAction({ courseId: "k1", cardId: "a", action: "edit", fields: { Back: "A-a!" } }, NOW, deps);
		assert.equal(manual.card?.siblings, 0);
		assert.equal(manual.card?.fields.Back, "A-a!");
		assert.equal(deps.store.readCards().find((c) => c.id === "b")?.fields.Back, "A-b");
	});

	it("editing validates the fields before writing anything", () => {
		const { deps } = setup();
		const before = deps.store.readCards();
		const bad = (fields: unknown) =>
			assert.throws(
				() => studyCardAction({ courseId: "k1", cardId: "a", action: "edit", fields: fields as Record<string, string> }, NOW, deps),
				(e) => e instanceof StudyInputError && e.status === 400,
			);
		bad({});
		bad({ Nope: "x" });
		bad({ Front: 5 });
		bad({ Front: "x".repeat(200_001) });
		bad(["Front"]);
		bad(null);
		assert.throws(
			() => studyCardAction({ courseId: "k2", cardId: "a", action: "suspend" }, NOW, deps),
			(e) => e instanceof StudyInputError && e.status === 404,
		);
		assert.throws(
			() => studyCardAction({ courseId: "k1", cardId: "a", action: "explode" as "edit" }, NOW, deps),
			StudyInputError,
		);
		assert.deepEqual(deps.store.readCards(), before);
	});

	it("the card view carries its fields for the MCQ check", () => {
		const { deps } = setup();
		deps.store.upsertCard({
			id: "m1",
			courseId: "k2",
			kind: "mcq",
			fields: { Question: "Q", OptionA: "a", OptionB: "b", OptionC: "", OptionD: "", Correct: "A" },
			tags: [],
			core: false,
			origin: { kind: "manual" },
			createdAt: NOW.toISOString(),
		});
		const out = studyNext("k2", 0, NOW, deps);
		assert.equal(out.card?.kind, "mcq");
		assert.equal(out.card?.fields.Correct, "A");
		assert.match(out.card?.front ?? "", /data-key="A"/);
		assert.doesNotMatch(out.card?.front ?? "", /data-ok/);
	});
});

describe("adding a course", () => {
	it("stores a course under the slug of its name, with the defaults", () => {
		const { deps } = setup();
		const course = createStudyCourse({ name: "  Medical   Biology " }, NOW, deps);
		assert.deepEqual(course, { id: "medical-biology", name: "Medical Biology", bufferDays: 5, createdAt: NOW.toISOString() });
		assert.ok(deps.store.readCourses().some((c) => c.id === "medical-biology"));
		assert.ok(studyCourses(NOW, deps).some((c) => c.id === "medical-biology" && c.total === 0));
	});

	it("takes a real deadline and a buffer within bounds", () => {
		const { deps } = setup();
		const course = createStudyCourse({ name: "Physics", deadline: "2026-12-20", bufferDays: 99 }, NOW, deps);
		assert.equal(course.deadline, "2026-12-20");
		assert.equal(course.bufferDays, 60);
		assert.equal(createStudyCourse({ name: "Chemistry", deadline: "" }, NOW, deps).deadline, undefined);
	});

	it("refuses an empty or long name, a taken name (any case) and a deadline that is no date", () => {
		const { deps } = setup();
		const refused = (input: object) => () => createStudyCourse(input, NOW, deps);
		const bad = (e: unknown) => e instanceof StudyInputError && e.status === 400;
		assert.throws(refused({ name: "  " }), bad);
		assert.throws(refused({}), bad);
		assert.throws(refused({ name: "x".repeat(81) }), bad);
		assert.throws(refused({ name: "ANATOMIE" }), bad);
		assert.throws(refused({ name: "A", deadline: "2026-02-30" }), bad);
		assert.throws(refused({ name: "A", deadline: "soon" }), bad);
		assert.equal(deps.store.readCourses().length, 2, "nothing was added");
	});
});
