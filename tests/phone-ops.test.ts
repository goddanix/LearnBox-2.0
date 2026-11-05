/**
 * Card changes travelling from the phone back to the Mac (Learnbox 2.0, Slice 10e): reading changes off the wire,
 * taking them into the cards (the newer change wins, repeating is harmless), and their place in the backup file and
 * in the sentence that says what happened.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PhoneCardOp } from "../src/core/contracts/mobile.ts";
import type { StudyCard, StudyCourse } from "../src/core/contracts/study.ts";
import { createMemoryStudyStore } from "../src/core/memory-study-store.ts";
import { acceptPhoneOps, cleanCardOp, cleanCardOps, MAX_PHONE_OPS, newOps, opKey } from "../src/core/phone-ops.ts";
import { acceptPhoneChanges, buildPhoneBackup, readPhoneBackup, syncSummary } from "../src/core/phone-sync.ts";
import { applyStudyCardChange, StudyInputError, studyCardAction } from "../src/core/study-engine.ts";

const NOW = new Date(2026, 10, 5, 19, 52, 7);
const course: StudyCourse = { id: "k1", name: "k1", bufferDays: 5, createdAt: NOW.toISOString() };
const card = (id: string, extra: Partial<StudyCard> = {}): StudyCard => ({
	id,
	courseId: "k1",
	kind: "basic",
	fields: { Front: `Q-${id}`, Back: `A-${id}` },
	tags: [],
	core: false,
	origin: { kind: "manual" },
	createdAt: NOW.toISOString(),
	...extra,
});
const store = (...cards: StudyCard[]) => createMemoryStudyStore({ courses: [course], cards });
const op = (cardId: string, action: PhoneCardOp["action"], at: string, fields?: Record<string, string>): PhoneCardOp => ({ cardId, action, at, ...(fields ? { fields } : {}) });
const T1 = "2026-11-05T09:00:00.000Z";
const T2 = "2026-11-05T10:00:00.000Z";
const T3 = "2026-11-05T11:00:00.000Z";
const cardOf = (s: ReturnType<typeof store>, id: string) => s.readCards().find((c) => c.id === id)!;

describe("a card change off the wire", () => {
	it("keeps what it knows and drops what it does not", () => {
		assert.deepEqual(cleanCardOp({ cardId: "c1", action: "suspend", at: T1, extra: 1, fields: { Front: "x" } }), { cardId: "c1", action: "suspend", at: T1 });
		assert.deepEqual(cleanCardOp({ cardId: "c1", action: "edit", at: T1, fields: { Front: "new", Back: "b" }, junk: true }), { cardId: "c1", action: "edit", at: T1, fields: { Front: "new", Back: "b" } });
	});

	it("refuses what is not a change", () => {
		for (const bad of [
			null, "x", [], {},
			{ action: "suspend", at: T1 },
			{ cardId: "", action: "suspend", at: T1 },
			{ cardId: "c1", action: "delete", at: T1 },
			{ cardId: "c1", action: "suspend" },
			{ cardId: "c1", action: "suspend", at: "yesterday" },
			{ cardId: "c1", action: "suspend", at: "2026-13-45T00:00:00Z" },
			{ cardId: "c1", action: "edit", at: T1 },
			{ cardId: "c1", action: "edit", at: T1, fields: {} },
			{ cardId: "c1", action: "edit", at: T1, fields: { Front: 5 } },
			{ cardId: "c1", action: "edit", at: T1, fields: ["x"] },
			{ cardId: "c".repeat(201), action: "suspend", at: T1 },
		]) assert.equal(cleanCardOp(bad), null, JSON.stringify(bad));
	});

	it("counts the entries of a list that are not changes, and refuses what is not a list or is far too long", () => {
		const list = cleanCardOps([op("c1", "bury", T1), { nonsense: 1 }, op("c2", "unbury", T2)])!;
		assert.deepEqual([list.ops.length, list.rejected], [2, 1]);
		for (const bad of [null, "x", {}, 3]) assert.equal(cleanCardOps(bad), null);
		assert.equal(cleanCardOps(new Array(MAX_PHONE_OPS + 1).fill(op("c1", "bury", T1))), null);
	});

	it("is the same change wherever a copy turns up: each once, oldest first", () => {
		const a = op("c1", "suspend", T2);
		const b = op("c2", "bury", T1);
		assert.equal(opKey(a), opKey({ ...a }));
		assert.notEqual(opKey(a), opKey(op("c1", "unsuspend", T2)));
		assert.deepEqual(newOps([], [a, b, { ...a }]), [b, a]);
		assert.deepEqual(newOps([a], [a, b]), [b]);
	});
});

describe("taking card changes into the Mac's cards", () => {
	it("pauses, buries and edits, and stamps what it touched with the moment the learner did it", () => {
		const s = store(card("c1"), card("c2"), card("c3"));
		const result = acceptPhoneOps(s, [op("c1", "suspend", T1), op("c2", "bury", T1), op("c3", "edit", T1, { Front: "Changed?" })])!;
		assert.deepEqual(result, { applied: 3, known: 0, newerOnMac: 0, unknownCards: 0, rejected: 0 });
		assert.equal(cardOf(s, "c1").suspended, true);
		assert.equal(cardOf(s, "c1").editedAt, T1);
		assert.equal(cardOf(s, "c2").buriedUntil, "2026-11-06", "buried until the next study day, by the phone's clock");
		assert.equal(cardOf(s, "c3").fields.Front, "Changed?");
		assert.equal(cardOf(s, "c3").fields.Back, "A-c3");
		assert.equal(cardOf(s, "c3").editedAt, T1);
	});

	it("runs several changes to one card in the order they were made, whatever order they arrive in", () => {
		const s = store(card("c1"));
		acceptPhoneOps(s, [op("c1", "unsuspend", T2), op("c1", "suspend", T1)]);
		assert.equal(cardOf(s, "c1").suspended, undefined, "suspended at T1, taken back at T2");
		assert.equal(cardOf(s, "c1").editedAt, T2);
	});

	it("takes a change in only once: sent again, it is known", () => {
		const s = store(card("c1"));
		const changes = [op("c1", "suspend", T1)];
		assert.equal(acceptPhoneOps(s, changes)!.applied, 1);
		assert.deepEqual(acceptPhoneOps(s, changes), { applied: 0, known: 1, newerOnMac: 0, unknownCards: 0, rejected: 0 });
	});

	it("leaves a change out when the card was changed on the Mac after the learner made it: the newer wins", () => {
		const s = store(card("c1"));
		studyCardAction({ courseId: "k1", cardId: "c1", action: "edit", fields: { Front: "Mac wrote this" } }, new Date(T3), { store: s, resolve: () => null });
		const result = acceptPhoneOps(s, [op("c1", "edit", T2, { Front: "Phone wrote this" }), op("c1", "suspend", T1)])!;
		assert.deepEqual(result, { applied: 0, known: 0, newerOnMac: 2, unknownCards: 0, rejected: 0 });
		assert.equal(cardOf(s, "c1").fields.Front, "Mac wrote this");
		assert.equal(cardOf(s, "c1").suspended, undefined);
	});

	it("takes the phone's change when the Mac's own change to the card is older", () => {
		const s = store(card("c1", { editedAt: T1 }));
		const result = acceptPhoneOps(s, [op("c1", "edit", T2, { Front: "Phone wrote this" })])!;
		assert.equal(result.applied, 1);
		assert.equal(cardOf(s, "c1").fields.Front, "Phone wrote this");
	});

	it("counts a change for a card that is gone, and one that cannot be used — and carries on with the rest", () => {
		const s = store(card("c1"), card("c2"));
		const result = acceptPhoneOps(s, [op("gone", "suspend", T1), op("c1", "edit", T1, { NoSuchField: "x" }), op("c2", "suspend", T2), { nonsense: 1 }])!;
		assert.deepEqual(result, { applied: 1, known: 0, newerOnMac: 0, unknownCards: 1, rejected: 2 });
		assert.equal(cardOf(s, "c2").suspended, true);
		assert.equal(cardOf(s, "c1").editedAt, undefined);
	});

	it("changes the other cards of the same Anki note along with an edit", () => {
		const note = (id: string, variant: number) => card(id, { origin: { kind: "anki-import", noteId: 7, deckName: "d" } as StudyCard["origin"], variant, fields: { Front: "old", Back: "b" } });
		const s = store(note("a", 0), note("b", 1), card("other"));
		acceptPhoneOps(s, [op("a", "edit", T1, { Front: "new" })]);
		assert.deepEqual([cardOf(s, "a").fields.Front, cardOf(s, "b").fields.Front, cardOf(s, "other").fields.Front], ["new", "new", "Q-other"]);
		assert.equal(cardOf(s, "b").editedAt, T1);
	});

	it("refuses what is not a list", () => {
		for (const bad of [null, "x", {}, 3]) assert.equal(acceptPhoneOps(store(card("c1")), bad), null);
	});
});

describe("one change on the Mac, in the engine", () => {
	const deps = (s: ReturnType<typeof store>) => ({ store: s, resolve: () => null });

	it("stamps the card with `now` and keeps the answer to the screen as before", () => {
		const s = store(card("c1"), card("c2"));
		const next = studyCardAction({ courseId: "k1", cardId: "c1", action: "suspend" }, new Date(T1), deps(s));
		assert.equal(cardOf(s, "c1").editedAt, T1);
		assert.notEqual(next.card?.id, "c1", "a suspended card is gone from the queue");
		const back = studyCardAction({ courseId: "k1", cardId: "c1", action: "unsuspend" }, new Date(T2), deps(s));
		assert.equal(back.card?.id, "c1", "a takeback shows the card again");
		assert.equal(cardOf(s, "c1").editedAt, T2);
	});

	it("is the card change alone, without a course, for what the phone queued", () => {
		const s = store(card("c1"));
		applyStudyCardChange({ cardId: "c1", action: "suspend" }, new Date(T1), deps(s));
		assert.equal(cardOf(s, "c1").suspended, true);
		assert.throws(() => applyStudyCardChange({ cardId: "nope", action: "suspend" }, new Date(T1), deps(s)), (e) => e instanceof StudyInputError && e.status === 404);
		assert.throws(() => applyStudyCardChange({ cardId: "c1", courseId: "other-course", action: "suspend" }, new Date(T1), deps(s)), StudyInputError);
		assert.throws(() => applyStudyCardChange({ cardId: "c1", action: "edit", fields: {} }, new Date(T1), deps(s)), /Nothing to edit/);
	});

	it("does not stamp an edit that changes nothing", () => {
		const s = store(card("c1"));
		applyStudyCardChange({ cardId: "c1", action: "edit", fields: { Front: "Q-c1" } }, new Date(T1), deps(s));
		assert.equal(cardOf(s, "c1").editedAt, undefined);
	});
});

describe("a whole upload", () => {
	it("takes answers and card changes together, either list on its own, and says what happened to both", () => {
		const s = store(card("c1"), card("c2"));
		const both = acceptPhoneChanges(s, { reviews: [{ cardId: "c1", at: T1, grade: 3 }], ops: [op("c2", "suspend", T1)] })!;
		assert.deepEqual([both.added, both.cardChanges.applied], [1, 1]);
		assert.equal(acceptPhoneChanges(s, { ops: [op("c1", "bury", T2)] })!.added, 0);
		assert.equal(acceptPhoneChanges(s, { reviews: [{ cardId: "c2", at: T2, grade: 2 }] })!.cardChanges.applied, 0);
	});

	it("changes nothing when either list is not a list", () => {
		const s = store(card("c1"));
		assert.equal(acceptPhoneChanges(s, { reviews: [{ cardId: "c1", at: T1, grade: 3 }], ops: "no" }), null);
		assert.equal(acceptPhoneChanges(s, { reviews: "no", ops: [op("c1", "suspend", T1)] }), null);
		assert.equal(acceptPhoneChanges(s, {}), null);
		assert.equal(s.readReviews().length, 0);
		assert.equal(cardOf(s, "c1").suspended, undefined);
	});
});

describe("the backup file with card changes", () => {
	const ops = [op("c1", "suspend", T1), op("c2", "edit", T2, { Front: "x" })];

	it("carries them, and leaves the key out when there are none, as the files of Slice 10d were", () => {
		assert.deepEqual(buildPhoneBackup([], NOW, "iPhone", ops).ops, ops);
		assert.equal("ops" in buildPhoneBackup([], NOW, "iPhone"), false);
		assert.equal("ops" in buildPhoneBackup([], NOW, "iPhone", []), false);
	});

	it("is read back with them, counting the ones that are not changes; an old file without them still reads", () => {
		const file = JSON.parse(JSON.stringify({ ...buildPhoneBackup([{ cardId: "c1", at: T1, grade: 3 }], NOW, "iPhone", ops), ops: [...ops, { nonsense: 1 }] }));
		const read = readPhoneBackup(file)!;
		assert.deepEqual(read.backup.ops, ops);
		assert.equal(read.rejected, 1);
		const old = readPhoneBackup({ v: 1, kind: "learnbox-phone-backup", createdAt: NOW.toISOString(), reviews: [] })!;
		assert.equal(old.backup.ops, undefined);
		assert.equal(readPhoneBackup({ ...file, ops: "no" }), null, "a file whose card changes are not a list is not one of ours");
	});

	it("goes into the Mac once, however it comes", () => {
		const s = store(card("c1"), card("c2"));
		const file = readPhoneBackup(JSON.parse(JSON.stringify(buildPhoneBackup([], NOW, "iPhone", ops))))!.backup;
		assert.equal(acceptPhoneChanges(s, { reviews: file.reviews, ops: file.ops })!.cardChanges.applied, 2);
		assert.equal(acceptPhoneChanges(s, { reviews: file.reviews, ops })!.cardChanges.known, 2);
	});
});

describe("the sentence", () => {
	const base = { added: 0, known: 0, unknownCards: 0, rejected: 0, reviewsTotal: 5 };
	it("tells about card changes after the answers, and says nothing of them when there were none", () => {
		assert.equal(syncSummary({ ...base, cardChanges: { applied: 0, known: 0, newerOnMac: 0, unknownCards: 0, rejected: 0 } }), "0 new answers taken in.");
		assert.equal(
			syncSummary({ ...base, added: 2, cardChanges: { applied: 1, known: 2, newerOnMac: 1, unknownCards: 1, rejected: 3 } }),
			"2 new answers taken in, 1 card change taken in, 2 card changes already there, 1 card change left out because the card was changed on the Mac since, 1 card change for cards that no longer exist skipped, 3 card changes could not be used.",
		);
	});
});
