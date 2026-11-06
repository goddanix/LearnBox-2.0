/**
 * The cards file (Learnbox 2.0, Slice 10g): its layout (magic, header, media bytes back to back), reading it back and
 * refusing what is not one or was cut short, and the phone side — saving what the phone holds and loading a file in:
 * onto an empty phone, over an older one, never over newer cards, answers and changes merged once, no Mac involved.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCardsFile, cardsLoadedText, importCardsFile } from "../components/mobile/phone-cards-file.ts";
import { createMemoryPhoneDb, heldCourseIds } from "../components/mobile/phone-db.ts";
import type { PhoneDb, PhoneMeta } from "../components/mobile/phone-db.ts";
import { PHONE_CARDS_KIND, PHONE_CARDS_SCHEMA } from "../src/core/contracts/mobile.ts";
import type { PhoneCardOp, PhoneCardsHeader } from "../src/core/contracts/mobile.ts";
import type { StudyCard, StudyCourse, StudyReview } from "../src/core/contracts/study.ts";
import { cardsFileName, cardsFileParts, PHONE_CARDS_EXTENSION, readPhoneCardsFile, readPhoneCardsHeader } from "../src/core/phone-cards-file.ts";

const NOW = new Date(2026, 10, 6, 11, 30, 0);
const OLD = "2026-11-01T08:00:00.000Z";
const NEW = "2026-11-05T08:00:00.000Z";
const course = (id: string): StudyCourse => ({ id, name: id, bufferDays: 5, createdAt: OLD });
const card = (id: string, over: Partial<StudyCard> = {}): StudyCard => ({
	id,
	courseId: "k1",
	kind: "basic",
	fields: { Front: `Q-${id}`, Back: `A-${id}` },
	tags: [],
	core: false,
	origin: { kind: "manual" },
	createdAt: OLD,
	...over,
});
const review = (cardId: string, at: string, grade: 1 | 2 | 3 | 4 = 3): StudyReview => ({ cardId, at, grade });
const bytes = (...n: number[]) => new Uint8Array(n).buffer;
const meta = (deckAt: string, over: Partial<PhoneMeta> = {}): PhoneMeta => ({ v: 1, deckAt, syncedAt: deckAt, macReviews: 2, ...over });
const edit = (cardId: string, at: string): PhoneCardOp => ({ cardId, action: "edit", at, fields: { Front: `edited ${cardId}` } });

const header = (over: Partial<PhoneCardsHeader> = {}): PhoneCardsHeader => ({
	v: PHONE_CARDS_SCHEMA,
	kind: PHONE_CARDS_KIND,
	createdAt: NOW.toISOString(),
	deckAt: NEW,
	macReviews: 1,
	held: ["k1"],
	courses: [course("k1")],
	cards: [card("1")],
	reviews: [review("1", "2026-11-02T09:00:00.000Z")],
	unsent: [],
	ops: [],
	media: [],
	...over,
});
const blobOf = (h: PhoneCardsHeader, media: ArrayBuffer[] = []) => new Blob(cardsFileParts(h, media));

/** A phone holding a deck: one course, the given cards, two Mac lines, one picture. */
async function phone(deckAt: string, over: { cards?: StudyCard[]; unsent?: StudyReview[]; ops?: PhoneCardOp[]; media?: Record<string, ArrayBuffer> } = {}): Promise<PhoneDb> {
	const db = createMemoryPhoneDb();
	await db.applyDeck({ meta: meta(deckAt, { courses: ["k1"], catalog: [{ id: "k1", name: "k1", cards: 2, mediaBytes: 3 }] }), courses: [course("k1")], cards: over.cards ?? [card("1"), card("2")], macReviews: [review("1", "2026-11-02T09:00:00.000Z"), review("2", "2026-11-03T09:00:00.000Z")] });
	for (const [name, data] of Object.entries(over.media ?? { "a.png": bytes(1, 2, 3) })) await db.putMedia({ name, mime: "image/png", bytes: data });
	if ((over.unsent ?? []).length > 0) await db.addReviews(over.unsent!);
	for (const op of over.ops ?? []) await db.addCardChange(op, []);
	return db;
}

describe("the file's layout", () => {
	it("is magic, header length, header, then every media file's bytes — and reads back as written", async () => {
		const h = header({ media: [{ name: "a.png", mime: "image/png", size: 3 }, { name: "b.mp3", mime: "audio/mpeg", size: 2 }] });
		const file = blobOf(h, [bytes(1, 2, 3), bytes(9, 8)]);
		const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
		assert.equal(new TextDecoder().decode(head), "LBDECK1\n");
		const read = await readPhoneCardsFile(file);
		assert.ok(read.ok);
		assert.deepEqual(read.header, h);
		assert.equal(read.rejected, 0);
		assert.deepEqual(read.media.map((m) => [m.name, m.mime, m.size]), [["a.png", "image/png", 3], ["b.mp3", "audio/mpeg", 2]]);
		assert.deepEqual([...new Uint8Array(await read.media[0]!.read())], [1, 2, 3]);
		assert.deepEqual([...new Uint8Array(await read.media[1]!.read())], [9, 8], "each file is cut from its own place");
	});

	it("costs what the media weighs: no base64", async () => {
		const big = new Uint8Array(100_000).fill(200).buffer;
		const withMedia = blobOf(header({ media: [{ name: "big.png", mime: "image/png", size: 100_000 }] }), [big]);
		const without = blobOf(header());
		assert.ok(withMedia.size - without.size < 100_100, `${withMedia.size - without.size} bytes for 100000`);
	});

	it("refuses media that does not match its header", () => {
		assert.throws(() => cardsFileParts(header({ media: [{ name: "a.png", mime: "image/png", size: 3 }] }), [bytes(1)]));
		assert.throws(() => cardsFileParts(header({ media: [{ name: "a.png", mime: "image/png", size: 1 }] }), []));
	});

	it("names the file with the phone's local time", () => {
		assert.equal(cardsFileName(NOW), "learnbox-cards-2026-11-06-1130.lbdeck");
		assert.ok(cardsFileName(NOW).endsWith(PHONE_CARDS_EXTENSION));
	});
});

describe("what is not a cards file", () => {
	const reason = async (file: Blob) => {
		const read = await readPhoneCardsFile(file);
		return read.ok ? "ok" : read.reason;
	};

	it("is not ours when it has no magic, however it looks", async () => {
		for (const part of ["", "x", "{}", "not a file at all", JSON.stringify({ v: 1, kind: PHONE_CARDS_KIND })]) assert.equal(await reason(new Blob([part])), "not-ours", part);
		assert.equal(await reason(new Blob([new Uint8Array(40)])), "not-ours");
	});

	it("is damaged when it is cut short — in the header or among the media", async () => {
		const h = header({ media: [{ name: "a.png", mime: "image/png", size: 3 }] });
		const whole = new Uint8Array(await blobOf(h, [bytes(1, 2, 3)]).arrayBuffer());
		assert.equal(await reason(new Blob([whole])), "ok");
		for (const cut of [whole.length - 1, whole.length - 3, 20, 13]) assert.equal(await reason(new Blob([whole.subarray(0, cut)])), "damaged", `cut at ${cut}`);
		assert.equal(await reason(new Blob([whole, new Uint8Array(1)])), "damaged", "or has something added");
	});

	it("is damaged when the header is not a header", async () => {
		const prefix = (json: string) => {
			const text = new TextEncoder().encode(json);
			const out = new Uint8Array(12 + text.length);
			out.set(new TextEncoder().encode("LBDECK1\n"));
			new DataView(out.buffer).setUint32(8, text.length);
			out.set(text, 12);
			return new Blob([out]);
		};
		const good = header();
		for (const bad of ["{", "[]", "null", JSON.stringify({ ...good, v: 2 }), JSON.stringify({ ...good, kind: "other" }), JSON.stringify({ ...good, cards: "no" }), JSON.stringify({ ...good, courses: [{ id: 1 }] }), JSON.stringify({ ...good, macReviews: -1 })]) {
			assert.equal(await reason(prefix(bad)), "damaged", bad.slice(0, 40));
		}
		assert.equal(await reason(prefix(JSON.stringify(good))), "ok");
	});

	it("is damaged when a media entry is not safe or not unique", async () => {
		for (const media of [
			[{ name: "../x.png", mime: "image/png", size: 0 }],
			[{ name: "a/b.png", mime: "image/png", size: 0 }],
			[{ name: ".hidden", mime: "image/png", size: 0 }],
			[{ name: "", mime: "image/png", size: 0 }],
			[{ name: "a.png", mime: 5, size: 0 }],
			[{ name: "a.png", mime: "image/png", size: -1 }],
			[{ name: "a.png", mime: "image/png", size: 0 }, { name: "a.png", mime: "image/png", size: 0 }],
		]) assert.equal(readPhoneCardsHeader({ ...header(), media }), null, JSON.stringify(media));
	});

	it("counts the answers and changes it cannot read instead of guessing at them", () => {
		const read = readPhoneCardsHeader({ ...header(), unsent: [review("1", "2026-11-04T09:00:00.000Z"), { junk: true }], ops: [edit("1", "2026-11-04T09:01:00.000Z"), { action: "nope" }] });
		assert.ok(read);
		assert.deepEqual([read.header.unsent.length, read.header.ops.length, read.rejected], [1, 1, 2]);
	});
});

describe("saving what the phone holds", () => {
	it("is everything: courses, cards, the Mac's lines, the answers only the phone has, its card changes and the media", async () => {
		const db = await phone(NEW, { unsent: [review("2", "2026-11-05T10:00:00.000Z", 4)], ops: [edit("1", "2026-11-05T10:05:00.000Z")], media: { "a.png": bytes(1, 2, 3), "s.mp3": bytes(7) } });
		const prepared = (await buildCardsFile(db, NOW, "Danny's iPhone"))!;
		assert.deepEqual([prepared.cards, prepared.courses, prepared.media], [2, 1, 2]);
		assert.equal(prepared.file.name, "learnbox-cards-2026-11-06-1130.lbdeck");
		assert.equal(prepared.bytes, prepared.file.size);
		const read = await readPhoneCardsFile(prepared.file);
		assert.ok(read.ok);
		const h = read.header;
		assert.deepEqual([h.device, h.deckAt, h.macReviews, h.held], ["Danny's iPhone", NEW, 2, ["k1"]]);
		assert.deepEqual(h.cards.map((c) => c.id), ["1", "2"]);
		assert.equal(h.reviews.length, 2, "the Mac's lines");
		assert.deepEqual(h.unsent.map((r) => r.cardId), ["2"], "the phone's own, not yet sent");
		assert.deepEqual(h.ops.map((o) => o.cardId), ["1"]);
		assert.deepEqual(h.media.map((m) => [m.name, m.size]), [["a.png", 3], ["s.mp3", 1]]);
		assert.deepEqual(h.catalog?.map((c) => c.id), ["k1"]);
	});

	it("leaves out what the Mac already has of the phone's own work: sent answers travel as the Mac's lines", async () => {
		const db = await phone(NEW, { unsent: [review("2", "2026-11-05T10:00:00.000Z")] });
		await db.markSent([review("2", "2026-11-05T10:00:00.000Z")]);
		const read = await readPhoneCardsFile((await buildCardsFile(db, NOW))!.file);
		assert.ok(read.ok);
		assert.deepEqual([read.header.reviews.length, read.header.unsent.length], [3, 0]);
	});

	it("says there is nothing to save on a phone without a deck", async () => {
		assert.equal(await buildCardsFile(createMemoryPhoneDb(), NOW), null);
	});
});

describe("loading a file in", () => {
	it("restores a phone that lost everything: cards, media, the choice, the list, and what was still unsent", async () => {
		const saved = await phone(NEW, { unsent: [review("2", "2026-11-05T10:00:00.000Z", 4)], ops: [edit("1", "2026-11-05T10:05:00.000Z")], media: { "a.png": bytes(1, 2, 3) } });
		const file = (await buildCardsFile(saved, NOW))!.file;

		const empty = createMemoryPhoneDb();
		const result = await importCardsFile(empty, file);
		assert.deepEqual(result, { kind: "ok", tookDeck: true, cards: 2, courses: 1, media: 1, addedReviews: 1, addedOps: 1, rejected: 0 });
		const snap = (await empty.load())!;
		assert.deepEqual(snap.cards.map((c) => c.id), ["1", "2"]);
		assert.deepEqual([snap.meta.deckAt, snap.meta.syncedAt, snap.meta.macReviews], [NEW, NEW, 2]);
		assert.deepEqual(heldCourseIds(snap), ["k1"]);
		assert.deepEqual(snap.meta.catalog?.map((c) => c.id), ["k1"]);
		assert.deepEqual((await empty.unsentReviews()).map((r) => r.cardId), ["2"], "still waiting to go to the Mac");
		assert.deepEqual((await empty.unsentOps()).map((o) => o.cardId), ["1"]);
		assert.equal(snap.reviews.filter((r) => r.sent).length, 2, "the Mac's lines are marked as the Mac's");
		assert.deepEqual([...new Uint8Array((await empty.getMedia(["a.png"])).get("a.png")!.bytes)], [1, 2, 3]);
	});

	it("adds nothing the second time: the same file is the same answers", async () => {
		const file = (await buildCardsFile(await phone(NEW, { unsent: [review("2", "2026-11-05T10:00:00.000Z")], ops: [edit("1", "2026-11-05T10:05:00.000Z")] }), NOW))!.file;
		const db = createMemoryPhoneDb();
		await importCardsFile(db, file);
		const again = await importCardsFile(db, file);
		assert.ok(again.kind === "ok");
		assert.deepEqual([again.addedReviews, again.addedOps, again.tookDeck, again.skipped], [0, 0, false, "phone-newer"]);
		assert.equal((await db.load())!.reviews.length, 3);
	});

	it("takes the cards of a newer file over an older phone, and keeps the phone's own waiting answers", async () => {
		const file = (await buildCardsFile(await phone(NEW, { cards: [card("1"), card("2"), card("3")] }), NOW))!.file;
		const older = await phone(OLD, { cards: [card("1")], unsent: [review("1", "2026-11-04T09:00:00.000Z", 2)], media: { "gone.png": bytes(5), "a.png": bytes(1, 2, 3) } });
		const result = await importCardsFile(older, file);
		assert.ok(result.kind === "ok" && result.tookDeck);
		const snap = (await older.load())!;
		assert.deepEqual(snap.cards.map((c) => c.id), ["1", "2", "3"]);
		assert.equal(snap.meta.deckAt, NEW);
		assert.deepEqual((await older.unsentReviews()).map((r) => r.grade), [2], "the answer given on this phone is still waiting");
		assert.deepEqual((await older.mediaNames()).sort(), ["a.png"], "a picture no card of the file uses is dropped; the one it shares is not fetched twice");
	});

	it("does not replace newer cards with older ones — only the answers and changes join", async () => {
		const file = (await buildCardsFile(await phone(OLD, { cards: [card("1")], unsent: [review("1", "2026-11-04T09:00:00.000Z")], ops: [edit("1", "2026-11-04T09:30:00.000Z")] }), NOW))!.file;
		const newer = await phone(NEW, { cards: [card("1"), card("2")] });
		const result = await importCardsFile(newer, file);
		assert.deepEqual(result, { kind: "ok", tookDeck: false, skipped: "phone-newer", cards: 1, courses: 1, media: 0, addedReviews: 1, addedOps: 1, rejected: 0 });
		const snap = (await newer.load())!;
		assert.deepEqual(snap.cards.map((c) => c.id), ["1", "2"], "the phone's cards stay");
		assert.equal(snap.meta.deckAt, NEW);
		assert.equal((await newer.unsentReviews()).length, 1);
		assert.equal((await newer.unsentOps()).length, 1);
	});

	it("does not replace cards the learner changed on this phone since — those changes would be lost with them", async () => {
		const file = (await buildCardsFile(await phone(NEW), NOW))!.file;
		const older = await phone(OLD, { cards: [card("1")], ops: [edit("1", "2026-11-04T10:00:00.000Z")] });
		const result = await importCardsFile(older, file);
		assert.ok(result.kind === "ok");
		assert.deepEqual([result.tookDeck, result.skipped], [false, "changes-waiting"]);
		assert.deepEqual((await older.load())!.cards.map((c) => c.id), ["1"]);
		assert.equal((await older.unsentOps()).length, 1, "the change is still there to send");
	});

	it("takes the cards when the changes the phone has waiting are the ones the file carries too", async () => {
		const op = edit("1", "2026-11-04T10:00:00.000Z");
		const file = (await buildCardsFile(await phone(NEW, { ops: [op] }), NOW))!.file;
		const older = await phone(OLD, { cards: [card("1")], ops: [op] });
		const result = await importCardsFile(older, file);
		assert.ok(result.kind === "ok" && result.tookDeck);
		assert.equal((await older.unsentOps()).length, 1, "once, not twice");
	});

	it("changes nothing for a file that is not one, or was cut short", async () => {
		const db = await phone(NEW);
		const before = JSON.stringify((await db.load())!.cards);
		assert.deepEqual(await importCardsFile(db, new Blob(["hello"])), { kind: "not-ours" });
		const whole = new Uint8Array(await (await buildCardsFile(await phone(NEW), NOW))!.file.arrayBuffer());
		assert.deepEqual(await importCardsFile(db, new Blob([whole.subarray(0, whole.length - 5)])), { kind: "damaged" });
		assert.equal(JSON.stringify((await db.load())!.cards), before);
	});

	it("needs no Mac: nothing in here asks for the network", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (() => {
			throw new Error("no network expected");
		}) as typeof fetch;
		try {
			const file = (await buildCardsFile(await phone(NEW), NOW))!.file;
			await importCardsFile(createMemoryPhoneDb(), file);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("what loading says", () => {
	it("tells the loaded cards, the answers to send, and why cards were not taken", () => {
		assert.equal(cardsLoadedText({ kind: "not-ours" }), "This is not a Learnbox cards file.");
		assert.match(cardsLoadedText({ kind: "damaged" }), /cut short or damaged/);
		const ok = { kind: "ok" as const, tookDeck: true, cards: 1289, courses: 3, media: 12, addedReviews: 0, addedOps: 0, rejected: 0 };
		assert.equal(cardsLoadedText(ok), "Cards file loaded: 1289 cards in 3 courses, 12 pictures.");
		assert.equal(cardsLoadedText({ ...ok, cards: 1, courses: 1, media: 0, addedReviews: 1, addedOps: 2, rejected: 3 }), "Cards file loaded: 1 card in 1 course; 1 answer to send to the Mac, 2 card changes to send to the Mac, 3 unreadable skipped.");
		assert.equal(cardsLoadedText({ ...ok, tookDeck: false, skipped: "phone-newer" }), "Cards not taken: this phone already has cards that are as new or newer.");
		assert.match(cardsLoadedText({ ...ok, tookDeck: false, skipped: "changes-waiting", addedReviews: 4 }), /^Cards not taken: this phone has card changes the file does not have yet — update from the Mac first, or save a new file; 4 answers to send to the Mac\.$/);
	});
});
