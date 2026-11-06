/**
 * The phone's deck (Learnbox 2.0, Slice 10c): the in-memory ledgers, the media a card needs, cutting a deck on the
 * Mac (real fs store + media folder in a temp dir) and reading it back, and the study engine running over the
 * in-memory store — the very thing the phone does offline.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { PHONE_DECK_SCHEMA } from "../src/core/contracts/mobile.ts";
import type { StudyCard, StudyCourse, StudyReview } from "../src/core/contracts/study.ts";
import { createMemoryStudyStore, type StudyChange } from "../src/core/memory-study-store.ts";
import { buildPhoneCatalog, buildPhoneDeck, newReviews, phoneCatalogOf, readCourseIds, readPhoneCatalog, readPhoneDeck, reviewKey } from "../src/core/phone-deck.ts";
import { studyAnswer, studyCardAction, studyCourses, studyNext, studyUndo } from "../src/core/study-engine.ts";
import { mediaNamesOf } from "../src/core/study-render.ts";
import { phoneCatalog, phoneDeck, phoneMedia } from "../src/server/phone-deck.ts";
import { createStudyStore } from "../src/store/study.ts";

const NOW = new Date(2026, 10, 4, 10, 0, 0);
const course = (id: string, name = id): StudyCourse => ({ id, name, bufferDays: 5, createdAt: NOW.toISOString() });
const card = (id: string, over: Partial<StudyCard> = {}): StudyCard => ({
	id,
	courseId: "k1",
	kind: "basic",
	fields: { Front: `Q-${id}`, Back: `A-${id}` },
	tags: [],
	core: false,
	origin: { kind: "manual" },
	createdAt: NOW.toISOString(),
	...over,
});
const review = (cardId: string, at: string, grade: 1 | 2 | 3 | 4 = 3, undo?: true): StudyReview => ({ cardId, at, grade, ...(undo ? { undo } : {}) });

describe("the in-memory ledgers", () => {
	it("fold last-wins in first-appearance order, like the files", () => {
		const store = createMemoryStudyStore({ courses: [course("a", "A")], cards: [card("1"), card("2")] });
		store.upsertCard(card("1", { fields: { Front: "new", Back: "new" } }));
		store.upsertCourse(course("a", "A renamed"));
		assert.deepEqual(store.readCards().map((c) => [c.id, c.fields.Front]), [["1", "new"], ["2", "Q-2"]]);
		assert.equal(store.readCourses()[0]!.name, "A renamed");
		store.removeCard("1");
		assert.deepEqual(store.readCards().map((c) => c.id), ["2"]);
		store.appendReview(review("2", "2026-11-04T09:00:00.000Z"));
		store.appendReviews([review("2", "2026-11-04T09:01:00.000Z"), review("2", "2026-11-04T09:02:00.000Z", 1)]);
		assert.equal(store.readReviews().length, 3);
	});

	it("hands out copies: changing what was read changes nothing", () => {
		const store = createMemoryStudyStore({ cards: [card("1")] });
		store.readCards().pop();
		store.readReviews().push(review("1", "x"));
		assert.equal(store.readCards().length, 1);
		assert.equal(store.readReviews().length, 0);
	});

	it("tells a listener about every write, and only real ones", () => {
		const heard: StudyChange[] = [];
		const store = createMemoryStudyStore({ cards: [card("1")] }, (c) => heard.push(c));
		store.upsertCard(card("1"));
		store.upsertCards([]);
		store.appendReviews([]);
		store.removeCard("nope");
		store.appendReview(review("1", "2026-11-04T09:00:00.000Z"));
		store.removeCard("1");
		assert.deepEqual(heard.map((c) => c.kind), ["cards", "reviews", "card-removed"]);
	});
});

describe("the media a card needs", () => {
	it("is every file either side asks for, decoded, once; absolute and remote sources are not media", () => {
		const c = card("m", {
			fields: {
				Front: 'Look: <img src="arm%20bone.png"> <img src="arm%20bone.png">',
				Back: 'Sound [sound:ping.mp3] <img src="https://example.com/x.png"> <img src="/abs.png"> <img src=\'x y.jpg\'>',
			},
		});
		assert.deepEqual(mediaNamesOf(c).sort(), ["arm bone.png", "ping.mp3", "x y.jpg"]);
		assert.deepEqual(mediaNamesOf(card("plain")), []);
	});
});

describe("reviews travel as lines with an identity", () => {
	it("tells a copy of a line from a new one, within a batch too", () => {
		const a = review("c1", "2026-11-04T09:00:00.000Z");
		const b = review("c1", "2026-11-04T09:00:00.000Z", 3, true);
		assert.notEqual(reviewKey(a), reviewKey(b), "an undo line is its own line");
		assert.notEqual(reviewKey(a), reviewKey(review("c1", "2026-11-04T09:00:00.000Z", 4)));
		const fresh = review("c2", "2026-11-04T09:05:00.000Z");
		assert.deepEqual(newReviews([a], [a, fresh, fresh, b]), [fresh, b]);
		assert.deepEqual(newReviews([], []), []);
	});
});

describe("cutting a deck", () => {
	const store = () =>
		createMemoryStudyStore({
			courses: [course("k1")],
			cards: [card("1", { fields: { Front: '<img src="b.png">', Back: "[sound:a.mp3]" } }), card("2", { fields: { Front: '<img src="b.png">', Back: '<img src="gone.png">' } })],
			reviews: [review("1", "2026-11-01T09:00:00.000Z"), review("2", "2026-11-02T09:00:00.000Z"), review("1", "2026-11-03T09:00:00.000Z")],
		});
	const sizes: Record<string, number> = { "a.mp3": 10, "b.png": 20 };

	it("holds every course and card, the media that exists (sorted, once), and the ledger from where the phone stopped", () => {
		const deck = buildPhoneDeck(store(), (n) => sizes[n] ?? null, 1, NOW);
		assert.equal(deck.v, PHONE_DECK_SCHEMA);
		assert.equal(deck.at, NOW.toISOString());
		assert.deepEqual([deck.courses.length, deck.cards.length], [1, 2]);
		assert.deepEqual(deck.media, [{ name: "a.mp3", size: 10 }, { name: "b.png", size: 20 }]);
		assert.deepEqual([deck.reviewsFrom, deck.reviews.length, deck.reviewsTotal], [1, 2, 3]);
	});

	it("starts over from the first line when the phone claims more than the ledger has", () => {
		for (const from of [4, -1, 1.5, Number.NaN]) {
			const deck = buildPhoneDeck(store(), () => null, from, NOW);
			assert.deepEqual([deck.reviewsFrom, deck.reviews.length], [0, 3], String(from));
		}
		assert.deepEqual(buildPhoneDeck(store(), () => null, 3, NOW).reviews, [], "nothing new");
	});

	it("survives the wire and is read back; anything else is not a deck", () => {
		const deck = buildPhoneDeck(store(), (n) => sizes[n] ?? null, 0, NOW);
		const back = readPhoneDeck(JSON.parse(JSON.stringify(deck)));
		assert.deepEqual(back, deck);
		const broken: unknown[] = [
			null, "x", [], {}, { ...deck, v: 2 }, { ...deck, cards: "no" }, { ...deck, cards: [{ id: 1 }] }, { ...deck, courses: [{ id: "a" }] },
			{ ...deck, reviews: [{ cardId: "c", at: "x", grade: 9 }] }, { ...deck, reviewsTotal: 0 }, { ...deck, media: [{ name: "a" }] }, { ...deck, at: 5 },
		];
		for (const raw of broken) assert.equal(readPhoneDeck(raw), null, JSON.stringify(raw)?.slice(0, 60));
	});
});

describe("cutting a deck for the courses a phone chose", () => {
	const store = () =>
		createMemoryStudyStore({
			courses: [course("k1", "Anatomy"), course("k2", "Biology"), course("k3", "Empty")],
			cards: [
				card("1", { fields: { Front: '<img src="a.png"><img src="shared.png">', Back: "b" } }),
				card("2", { fields: { Front: '<img src="shared.png">', Back: "b" } }),
				card("3", { courseId: "k2", fields: { Front: '<img src="b.png"><img src="shared.png">', Back: "[sound:s.mp3]" } }),
			],
			reviews: [review("1", "2026-11-01T09:00:00.000Z"), review("3", "2026-11-02T09:00:00.000Z"), review("2", "2026-11-03T09:00:00.000Z"), review("3", "2026-11-04T09:00:00.000Z")],
		});
	const sizes: Record<string, number> = { "a.png": 10, "b.png": 20, "s.mp3": 30, "shared.png": 5 };
	const size = (n: string) => sizes[n] ?? null;

	it("holds only the chosen courses, their cards, the review lines of those cards and the media they use", () => {
		const deck = buildPhoneDeck(store(), size, 0, NOW, ["k2"]);
		assert.deepEqual(deck.courses.map((c) => c.id), ["k2"]);
		assert.deepEqual(deck.cards.map((c) => c.id), ["3"]);
		assert.deepEqual(deck.reviews.map((r) => r.cardId), ["3", "3"]);
		assert.deepEqual(deck.media.map((m) => m.name), ["b.png", "s.mp3", "shared.png"]);
	});

	it("keeps the ledger position whole: the phone asks from the end of the ledger next time, whatever it chose", () => {
		const deck = buildPhoneDeck(store(), size, 2, NOW, ["k1"]);
		assert.deepEqual([deck.reviewsFrom, deck.reviewsTotal], [2, 4]);
		assert.deepEqual(deck.reviews.map((r) => r.cardId), ["2"], "from line 2 on, only the lines of the chosen cards");
	});

	it("is everything when no choice is named, and nothing at all for an empty choice", () => {
		assert.equal(buildPhoneDeck(store(), size, 0, NOW).cards.length, 3);
		assert.equal(buildPhoneDeck(store(), size, 0, NOW, ["k1", "k2", "k3"]).cards.length, 3);
		const none = buildPhoneDeck(store(), size, 0, NOW, []);
		assert.deepEqual([none.courses, none.cards, none.reviews, none.media], [[], [], [], []]);
		assert.equal(buildPhoneDeck(store(), size, 0, NOW, ["gone"]).cards.length, 0, "an id the Mac does not know picks nothing");
	});

	it("always carries the catalog of every course, chosen or not", () => {
		const deck = buildPhoneDeck(store(), size, 0, NOW, ["k2"]);
		assert.deepEqual(deck.catalog?.map((c) => c.id), ["k1", "k2", "k3"]);
		assert.deepEqual(deck.catalog, buildPhoneCatalog(store(), size));
	});

	it("tells what a course would put on the phone: its cards, and its media counted once", () => {
		const list = buildPhoneCatalog(store(), size);
		assert.deepEqual(list.map((c) => [c.id, c.name, c.cards, c.mediaBytes]), [["k1", "Anatomy", 2, 15], ["k2", "Biology", 1, 55], ["k3", "Empty", 0, 0]]);
		assert.deepEqual(phoneCatalogOf(store(), size), { v: PHONE_DECK_SCHEMA, courses: list });
	});

	it("leaves out the size of media that is not on the Mac", () => {
		const list = buildPhoneCatalog(store(), (n) => (n === "a.png" ? 10 : null));
		assert.deepEqual(list.map((c) => c.mediaBytes), [10, 0, 0]);
	});

	it("reads the course list off an address: absent is all, empty is none, a list that cannot be one is null", () => {
		assert.equal(readCourseIds(null), undefined);
		assert.deepEqual(readCourseIds(""), []);
		assert.deepEqual(readCourseIds("a"), ["a"]);
		assert.deepEqual(readCourseIds("a,b,a"), ["a", "b"], "a name twice is once");
		for (const bad of ["a,", ",a", "a,,b", "x".repeat(121), Array.from({ length: 201 }, (_, i) => `c${i}`).join(",")]) assert.equal(readCourseIds(bad), null, bad.slice(0, 20));
		assert.equal(readCourseIds(Array.from({ length: 200 }, (_, i) => `c${i}`).join(","))?.length, 200);
	});

	it("reads a catalog back, and refuses one with the wrong shape", () => {
		const deck = buildPhoneDeck(store(), size, 0, NOW);
		assert.deepEqual(readPhoneDeck(JSON.parse(JSON.stringify(deck)))?.catalog, deck.catalog);
		const old: Partial<typeof deck> = { ...deck };
		delete old.catalog;
		assert.ok(readPhoneDeck(old), "decks cut before the catalog existed still read");
		for (const catalog of ["x", [{ id: "k" }], [{ id: "k", name: "n", cards: "1", mediaBytes: 0 }], [{ id: "k", name: "n", cards: 1, mediaBytes: Number.NaN }], [null]]) {
			assert.equal(readPhoneDeck({ ...deck, catalog }), null, JSON.stringify(catalog));
		}
		const wire = JSON.parse(JSON.stringify(phoneCatalogOf(store(), size))) as unknown;
		assert.equal(readPhoneCatalog(wire)?.length, 3);
		for (const raw of [null, {}, { v: 2, courses: [] }, { v: PHONE_DECK_SCHEMA, courses: "no" }, { v: PHONE_DECK_SCHEMA, courses: [{ id: 1 }] }]) assert.equal(readPhoneCatalog(raw), null, JSON.stringify(raw));
	});
});

describe("the Mac side: ledgers and media on disk", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "phone-deck-"));
	after(() => fs.rmSync(root, { recursive: true, force: true }));

	function setup() {
		const dir = fs.mkdtempSync(path.join(root, "case-"));
		const store = createStudyStore({ courses: path.join(dir, "courses.jsonl"), cards: path.join(dir, "cards.jsonl"), reviews: path.join(dir, "reviews.jsonl") });
		const mediaDir = path.join(dir, "media");
		fs.mkdirSync(mediaDir);
		fs.writeFileSync(path.join(mediaDir, "arm.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		fs.writeFileSync(path.join(mediaDir, "notes.txt"), "not media");
		fs.writeFileSync(path.join(mediaDir, ".hidden.png"), "x");
		store.upsertCourse(course("k1"));
		store.upsertCards([card("1", { fields: { Front: '<img src="arm.png"><img src="notes.txt"><img src=".hidden.png"><img src="missing.png">', Back: "b" } })]);
		store.appendReview(review("1", "2026-11-03T09:00:00.000Z"));
		return { store, mediaDir };
	}

	it("lists only media it can serve, and serves the bytes with their type", () => {
		const deps = setup();
		const deck = phoneDeck(0, NOW, deps);
		assert.deepEqual(deck.media, [{ name: "arm.png", size: 4 }]);
		assert.equal(deck.reviewsTotal, 1);
		const file = phoneMedia("arm.png", deps)!;
		assert.equal(file.mime, "image/png");
		assert.deepEqual([...file.bytes], [0x89, 0x50, 0x4e, 0x47]);
	});

	it("cuts a deck for chosen courses and lists the catalog, from the real files", () => {
		const deps = setup();
		deps.store.upsertCourse(course("k2", "Second"));
		deps.store.upsertCards([card("2", { courseId: "k2", fields: { Front: "no media", Back: "b" } })]);
		const only = phoneDeck(0, NOW, deps, ["k2"]);
		assert.deepEqual([only.courses.map((c) => c.id), only.cards.map((c) => c.id), only.media, only.reviews], [["k2"], ["2"], [], []]);
		assert.equal(only.reviewsTotal, 1, "the whole ledger's length");
		assert.deepEqual(phoneCatalog(deps).courses.map((c) => [c.id, c.cards, c.mediaBytes]), [["k1", 1, 4], ["k2", 1, 0]]);
		assert.deepEqual(phoneDeck(0, NOW, deps, []).cards, []);
	});

	it("serves nothing for names that point outside, hidden files, other types or missing files", () => {
		const deps = setup();
		for (const name of ["../x.png", "a/b.png", ".hidden.png", "notes.txt", "missing.png", "", "..", "arm.png/"]) assert.equal(phoneMedia(name, deps), null, JSON.stringify(name));
	});
});

describe("the engine over the in-memory ledgers (what the phone runs offline)", () => {
	const resolve = (name: string) => (name === "arm.png" ? "data:image/png;base64,AAAA" : null);
	const setup = () => {
		const store = createMemoryStudyStore({ courses: [course("k1")], cards: [card("1"), card("2"), card("3")] });
		return { store, resolve };
	};

	it("lists courses, serves cards, takes answers and undoes them", () => {
		const deps = setup();
		const list = studyCourses(NOW, deps);
		assert.deepEqual([list[0]!.id, list[0]!.total, list[0]!.counts.new], ["k1", 3, 3]);
		const first = studyNext("k1", 0, NOW, deps);
		assert.ok(first.card);
		const after = studyAnswer({ courseId: "k1", cardId: first.card!.id, grade: 3, ms: 900, step: first.step }, NOW, deps);
		assert.notEqual(after.card?.id, first.card!.id);
		assert.equal(deps.store.readReviews().length, 1);
		const back = studyUndo({ courseId: "k1", cardId: first.card!.id, step: first.step }, NOW, deps);
		assert.equal(back.card?.id, first.card!.id);
		assert.equal(deps.store.readReviews().length, 2, "an undo is a line, not an erasure");
	});

	it("inlines media through the resolver it is given", () => {
		const store = createMemoryStudyStore({ courses: [course("k1")], cards: [card("p", { fields: { Front: '<img src="arm.png">', Back: "b" } })] });
		const out = studyNext("k1", 0, NOW, { store, resolve });
		assert.match(out.card!.front, /src="data:image\/png;base64,AAAA"/);
	});

	it("suspends and buries a card (the phone's later card actions)", () => {
		const deps = setup();
		const out = studyCardAction({ courseId: "k1", cardId: "1", action: "suspend", step: 0 }, NOW, deps);
		assert.notEqual(out.card?.id, "1");
		assert.equal(deps.store.readCards().find((c) => c.id === "1")!.suspended, true);
	});
});
