import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isStudyLesson, PHONE_LESSON_ID, phoneLessonsOf } from "../src/core/phone-lessons.ts";
import type { ChatListItem } from "../src/core/contracts.ts";

const item = (over: Partial<ChatListItem> & { id: string }): ChatListItem => ({
	title: "A lesson",
	createdAt: "2026-11-01T10:00:00.000Z",
	updatedAt: "2026-11-01T10:00:00.000Z",
	kind: "teach",
	messageCount: 3,
	phase: "probe",
	pendingQuestion: false,
	pendingProblem: false,
	busy: false,
	compacting: false,
	...over,
});

describe("which sessions are study lessons", () => {
	it("takes teaching sessions tied to a course, to cards or to cards made from them", () => {
		assert.equal(isStudyLesson({ courseId: "anat" }), true);
		assert.equal(isStudyLesson({ kind: "teach", cardIds: ["c1"] }), true);
		assert.equal(isStudyLesson({ madeCardIds: ["c9"] }), true);
	});
	it("leaves out practice sessions and sessions with no study tie", () => {
		assert.equal(isStudyLesson({}), false);
		assert.equal(isStudyLesson({ kind: "teach", cardIds: [], madeCardIds: [] }), false);
		assert.equal(isStudyLesson({ kind: "practice", courseId: "anat" }), false);
		assert.equal(isStudyLesson({ courseId: "" }), false);
	});
});

describe("a chat id the phone may name", () => {
	it("is what the Mac makes, and nothing that could climb or split a path", () => {
		for (const ok of ["chat_mhx4k2_1a2b3c4d", "a", "A-b_9"]) assert.ok(PHONE_LESSON_ID.test(ok), ok);
		for (const bad of ["", "a/b", "..", "a.b", "a b", "a%2fb", "x".repeat(81), "chat\n1"]) assert.ok(!PHONE_LESSON_ID.test(bad), JSON.stringify(bad));
	});
});

describe("a course's lessons", () => {
	it("lists the course's lessons, latest first, with only what the phone needs", () => {
		const chats = [
			item({ id: "old", courseId: "anat", updatedAt: "2026-11-01T10:00:00.000Z" }),
			item({ id: "new", courseId: "anat", updatedAt: "2026-11-03T10:00:00.000Z", busy: true, pendingQuestion: true, title: "Median nerve" }),
			item({ id: "other", courseId: "bio" }),
			item({ id: "cards-only", cardIds: ["c1"] }),
			item({ id: "practice", courseId: "anat", kind: "practice" }),
			item({ id: "plain" }),
		];
		assert.deepEqual(phoneLessonsOf(chats, "anat"), [
			{ id: "new", title: "Median nerve", updatedAt: "2026-11-03T10:00:00.000Z", busy: true, pendingQuestion: true },
			{ id: "old", title: "A lesson", updatedAt: "2026-11-01T10:00:00.000Z", busy: false, pendingQuestion: false },
		]);
		assert.deepEqual(phoneLessonsOf(chats, "none"), []);
	});
});
