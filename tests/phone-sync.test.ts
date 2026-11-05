/**
 * Answers going back to the Mac (Learnbox 2.0, Slice 10d): reading review lines off the wire, taking them into the
 * ledger exactly once, the backup file, and the Mac side on real files.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { PHONE_BACKUP_KIND, PHONE_BACKUP_SCHEMA } from "../src/core/contracts/mobile.ts";
import type { StudyCard, StudyCourse, StudyReview } from "../src/core/contracts/study.ts";
import { createMemoryStudyStore } from "../src/core/memory-study-store.ts";
import { acceptPhoneReviews, backupFileName, buildPhoneBackup, cleanReviewLine, cleanReviewLines, MAX_PHONE_REVIEWS, readPhoneBackup, syncSummary } from "../src/core/phone-sync.ts";
import { studyCourses } from "../src/core/study-engine.ts";
import { acceptPhoneSync, importPhoneBackup, PhoneSyncInputError } from "../src/server/phone-sync.ts";
import { createStudyStore } from "../src/store/study.ts";

const NOW = new Date(2026, 10, 5, 19, 52, 7);
const course = (id: string): StudyCourse => ({ id, name: id, bufferDays: 5, createdAt: NOW.toISOString() });
const card = (id: string): StudyCard => ({ id, courseId: "k1", kind: "basic", fields: { Front: `Q-${id}`, Back: `A-${id}` }, tags: [], core: false, origin: { kind: "manual" }, createdAt: NOW.toISOString() });
const line = (cardId: string, at: string, grade: 1 | 2 | 3 | 4 = 3, extra: Partial<StudyReview> = {}): StudyReview => ({ cardId, at, grade, ...extra });
const AT = "2026-11-05T09:00:00.000Z";

describe("a review line off the wire", () => {
	it("keeps the five fields it knows and drops everything else", () => {
		assert.deepEqual(cleanReviewLine({ cardId: "c1", at: AT, grade: 3, ms: 1200, undo: true, extra: "x", __proto__: { evil: 1 } }), { cardId: "c1", at: AT, grade: 3, ms: 1200, undo: true });
		assert.deepEqual(cleanReviewLine({ cardId: "c1", at: AT, grade: 1 }), { cardId: "c1", at: AT, grade: 1 });
	});

	it("is not a line without a card, a real time or a grade from 1 to 4", () => {
		for (const bad of [null, "x", [], 3, {}, { cardId: "", at: AT, grade: 3 }, { cardId: 1, at: AT, grade: 3 }, { cardId: "c", at: "yesterday", grade: 3 }, { cardId: "c", at: "2026-13-45T99:00:00Z", grade: 3 }, { cardId: "c", at: AT, grade: 0 }, { cardId: "c", at: AT, grade: 5 }, { cardId: "c", at: AT, grade: "3" }, { cardId: "c".repeat(201), at: AT, grade: 3 }, { cardId: "c", at: AT + "x".repeat(40), grade: 3 }]) {
			assert.equal(cleanReviewLine(bad), null, JSON.stringify(bad)?.slice(0, 60));
		}
	});

	it("drops a duration that is not a plain number, and an undo that is not exactly true", () => {
		assert.deepEqual(cleanReviewLine({ cardId: "c", at: AT, grade: 3, ms: -5, undo: "yes" }), { cardId: "c", at: AT, grade: 3 });
		assert.deepEqual(cleanReviewLine({ cardId: "c", at: AT, grade: 3, ms: Number.NaN }), { cardId: "c", at: AT, grade: 3 });
		assert.deepEqual(cleanReviewLine({ cardId: "c", at: AT, grade: 3, ms: 0 }), { cardId: "c", at: AT, grade: 3, ms: 0 });
	});

	it("reads a list line by line and counts what it cannot read; anything but a list is refused", () => {
		const out = cleanReviewLines([line("a", AT), { nope: 1 }, line("b", AT, 4), null])!;
		assert.deepEqual([out.reviews.length, out.rejected], [2, 2]);
		for (const notAList of [null, undefined, "x", {}, 4]) assert.equal(cleanReviewLines(notAList), null);
		assert.equal(cleanReviewLines(new Array(MAX_PHONE_REVIEWS + 1).fill(line("a", AT))), null, "a stop for junk");
	});
});

describe("taking answers into the ledger", () => {
	const store = () => createMemoryStudyStore({ courses: [course("k1")], cards: [card("c1"), card("c2")], reviews: [line("c1", "2026-11-01T09:00:00.000Z")] });

	it("adds only what is new, once, and reports the rest", () => {
		const s = store();
		const upload = [line("c1", "2026-11-01T09:00:00.000Z"), line("c1", AT), line("c2", AT, 4), line("c2", AT, 4), line("gone", AT), { junk: true }];
		const first = acceptPhoneReviews(s, upload)!;
		assert.deepEqual(first, { added: 2, known: 2, unknownCards: 1, rejected: 1, reviewsTotal: 3 });
		assert.equal(s.readReviews().length, 3);
		const again = acceptPhoneReviews(s, upload)!;
		assert.deepEqual([again.added, again.known, again.unknownCards, again.reviewsTotal], [0, 4, 1, 3], "the second time nothing is added (the card that no longer exists is still not taken)");
		assert.equal(s.readReviews().length, 3);
	});

	it("keeps an undo line next to its answer", () => {
		const s = store();
		acceptPhoneReviews(s, [line("c2", AT, 3), line("c2", "2026-11-05T09:00:05.000Z", 3, { undo: true })]);
		assert.deepEqual(s.readReviews().slice(1).map((r) => !!r.undo), [false, true]);
	});

	it("writes once for the whole upload, and not at all when there is nothing new", () => {
		const writes: number[] = [];
		const s = createMemoryStudyStore({ courses: [course("k1")], cards: [card("c1")] }, (c) => c.kind === "reviews" && writes.push(c.reviews.length));
		acceptPhoneReviews(s, [line("c1", AT), line("c1", "2026-11-05T09:01:00.000Z")]);
		acceptPhoneReviews(s, [line("c1", AT)]);
		acceptPhoneReviews(s, []);
		assert.deepEqual(writes, [2]);
	});

	it("is null for something that is not a list, and leaves the ledger alone", () => {
		const s = store();
		assert.equal(acceptPhoneReviews(s, { reviews: [] }), null);
		assert.equal(s.readReviews().length, 1);
	});

	it("schedules from the merged ledger: the order the lines arrive in does not matter", () => {
		const a = createMemoryStudyStore({ courses: [course("k1")], cards: [card("c1")] });
		const b = createMemoryStudyStore({ courses: [course("k1")], cards: [card("c1")] });
		const lines = [line("c1", "2026-11-05T09:00:00.000Z", 3), line("c1", "2026-11-05T09:20:00.000Z", 1), line("c1", "2026-11-05T09:40:00.000Z", 3)];
		acceptPhoneReviews(a, lines);
		acceptPhoneReviews(b, [...lines].reverse());
		const view = (s: ReturnType<typeof store>) => JSON.stringify(studyCourses(new Date("2026-11-05T12:00:00.000Z"), { store: s, resolve: () => null }));
		assert.equal(view(a), view(b));
	});
});

describe("the backup file", () => {
	it("is built from the answers, with the phone's name, and read back unchanged", () => {
		const backup = buildPhoneBackup([line("c1", AT), line("c2", AT, 4, { ms: 900 })], NOW, "Danny's iPhone");
		assert.deepEqual([backup.v, backup.kind, backup.device, backup.reviews.length], [PHONE_BACKUP_SCHEMA, PHONE_BACKUP_KIND, "Danny's iPhone", 2]);
		const back = readPhoneBackup(JSON.parse(JSON.stringify(backup)))!;
		assert.deepEqual(back.backup, backup);
		assert.equal(back.rejected, 0);
		assert.equal(buildPhoneBackup([], NOW).device, undefined);
	});

	it("is named after the phone's local time", () => {
		assert.equal(backupFileName(NOW), "learnbox-backup-2026-11-05-1952.json");
		assert.equal(backupFileName(new Date(2026, 0, 2, 3, 4)), "learnbox-backup-2026-01-02-0304.json");
	});

	it("is refused unless it is one of ours: other files, other versions, no list of answers", () => {
		const ok = buildPhoneBackup([line("c1", AT)], NOW);
		for (const bad of [null, "x", [], {}, { ...ok, v: 2 }, { ...ok, kind: "something-else" }, { ...ok, createdAt: 5 }, { ...ok, reviews: "no" }, { ...ok, reviews: {} }]) {
			assert.equal(readPhoneBackup(bad), null, JSON.stringify(bad)?.slice(0, 60));
		}
	});

	it("counts the lines in it that are not answers, and ignores a device name that is not a short string", () => {
		const read = readPhoneBackup({ ...buildPhoneBackup([line("c1", AT)], NOW), reviews: [line("c1", AT), { bad: 1 }], device: "x".repeat(81) })!;
		assert.deepEqual([read.backup.reviews.length, read.rejected, read.backup.device], [1, 1, undefined]);
	});

	it("says what it did, in a sentence", () => {
		const none = { applied: 0, known: 0, newerOnMac: 0, unknownCards: 0, rejected: 0 };
		assert.equal(syncSummary({ added: 1, known: 0, unknownCards: 0, rejected: 0, reviewsTotal: 9, cardChanges: none }), "1 new answer taken in.");
		assert.equal(syncSummary({ added: 4, known: 3, unknownCards: 2, rejected: 1, reviewsTotal: 9, cardChanges: none }), "4 new answers taken in, 3 already there, 2 for cards that no longer exist skipped, 1 unreadable line skipped.");
	});
});

describe("the Mac side: the real ledger", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "phone-sync-"));
	after(() => fs.rmSync(root, { recursive: true, force: true }));
	function setup() {
		const dir = fs.mkdtempSync(path.join(root, "case-"));
		const store = createStudyStore({ courses: path.join(dir, "courses.jsonl"), cards: path.join(dir, "cards.jsonl"), reviews: path.join(dir, "reviews.jsonl") });
		store.upsertCourse(course("k1"));
		store.upsertCards([card("c1")]);
		return { store, mediaDir: path.join(dir, "media") };
	}

	it("takes the upload in once and says so when it is sent again", () => {
		const deps = setup();
		const body = { reviews: [line("c1", AT), line("c1", "2026-11-05T09:05:00.000Z", 2)] };
		assert.equal(acceptPhoneSync(body, deps).added, 2);
		assert.equal(acceptPhoneSync(body, deps).added, 0);
		assert.equal(deps.store.readReviews().length, 2);
	});

	it("refuses a body that is not { reviews: [...] }", () => {
		const deps = setup();
		for (const bad of [null, "x", [], {}, { reviews: "no" }, { review: [] }]) assert.throws(() => acceptPhoneSync(bad, deps), PhoneSyncInputError);
		assert.equal(deps.store.readReviews().length, 0);
	});

	it("reads a backup file in, counts its unreadable lines too, and refuses what is not a backup", () => {
		const deps = setup();
		const file = { ...buildPhoneBackup([line("c1", AT)], NOW, "iPhone"), reviews: [line("c1", AT), { bad: true }] };
		const result = importPhoneBackup(file, deps);
		assert.deepEqual([result.added, result.rejected], [1, 1]);
		assert.equal(importPhoneBackup(file, deps).added, 0, "reading it twice adds nothing");
		assert.throws(() => importPhoneBackup({ v: 1 }, deps), /not a Learnbox phone backup/);
	});

	it("takes a backup and then the same answers by the update without doubling them", () => {
		const deps = setup();
		const answers = [line("c1", AT), line("c1", "2026-11-05T09:10:00.000Z", 4)];
		importPhoneBackup(buildPhoneBackup(answers, NOW), deps);
		assert.equal(acceptPhoneSync({ reviews: answers }, deps).added, 0);
		assert.equal(deps.store.readReviews().length, 2);
	});
});
