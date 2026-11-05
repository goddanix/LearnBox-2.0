/**
 * The phone's storage, study engine and update from the Mac (Learnbox 2.0, Slices 10c/10d): the calls to the Mac and
 * the three ways they fail, the in-memory `PhoneDb`, the engine over it (offline studying, answers kept until the Mac
 * has them, pictures read from storage), `pullDeck` against a fake Mac, and the answers going back (`pushChanges`,
 * the update as a whole, a backup file's round trip).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createMemoryPhoneDb } from "../components/mobile/phone-db.ts";
import type { PhoneDb, PhoneMeta } from "../components/mobile/phone-db.ts";
import { startPhoneEngine, toDataUri } from "../components/mobile/phone-engine.ts";
import { PhoneApiError, phoneJson } from "../components/mobile/phone-http.ts";
import { getPhoneToken, setPhoneToken } from "../components/mobile/phone-auth.ts";
import { sourceOver } from "../components/mobile/phone-source.ts";
import { pullDeck } from "../components/mobile/pull-deck.ts";
import type { PullProgress } from "../components/mobile/pull-deck.ts";
import { pushChanges } from "../components/mobile/push-changes.ts";
import type { StudyCard, StudyCourse, StudyReview } from "../src/core/contracts/study.ts";
import { createMemoryStudyStore } from "../src/core/memory-study-store.ts";
import { buildPhoneDeck } from "../src/core/phone-deck.ts";
import { acceptPhoneChanges, buildPhoneBackup, readPhoneBackup } from "../src/core/phone-sync.ts";

const NOW = new Date(2026, 10, 4, 10, 0, 0);
const course = (id: string): StudyCourse => ({ id, name: id, bufferDays: 5, createdAt: NOW.toISOString() });
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
const review = (cardId: string, at: string, grade: 1 | 2 | 3 | 4 = 3): StudyReview => ({ cardId, at, grade });
const META: PhoneMeta = { v: 1, deckAt: NOW.toISOString(), syncedAt: NOW.toISOString(), macReviews: 0 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

const tokens = new Map<string, string>();
Object.assign(globalThis, {
	localStorage: {
		getItem: (k: string) => tokens.get(k) ?? null,
		setItem: (k: string, v: string) => void tokens.set(k, v),
		removeItem: (k: string) => void tokens.delete(k),
	},
});
const originalFetch = globalThis.fetch;
beforeEach(() => {
	tokens.clear();
	setPhoneToken("KEY");
});
afterEach(() => {
	globalThis.fetch = originalFetch;
});

/** A phone that already holds a deck: one course, the given cards, and a few reviews. */
async function phoneWith(cards: StudyCard[], reviews: StudyReview[] = []): Promise<PhoneDb> {
	const db = createMemoryPhoneDb();
	await db.applyDeck({ meta: META, courses: [course("k1")], cards, macReviews: reviews });
	return db;
}

describe("the calls to the Mac", () => {
	const answer = (res: Response | Error) => {
		globalThis.fetch = (async () => {
			if (res instanceof Error) throw res;
			return res.clone();
		}) as typeof fetch;
		return phoneJson("/api/x").then(
			() => "ok",
			(e: unknown) => (e instanceof PhoneApiError ? `${e.kind}: ${e.message}` : "other"),
		);
	};

	it("sends the phone's key along", async () => {
		let auth: string | null = null;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			auth = new Headers(init?.headers).get("Authorization");
			return Response.json({ ok: true });
		}) as typeof fetch;
		await phoneJson("/api/x");
		assert.equal(auth, "Bearer KEY");
	});

	it("tells unpaired, unreachable and server failures apart, and drops a key the Mac does not know", async () => {
		assert.match(await answer(new Response("{}", { status: 401 })), /^unpaired/);
		assert.equal(getPhoneToken(), null, "the key is dropped on a 401");
		assert.match(await answer(new Response("{}", { status: 502 })), /^unreachable/);
		assert.match(await answer(new TypeError("Failed to fetch")), /^unreachable: Cannot reach your Mac/);
		assert.equal(await answer(new Response(JSON.stringify({ error: "Unknown course" }), { status: 404 })), "server: Unknown course");
		assert.equal(await answer(new Response("nope", { status: 500 })), "server: Request failed (500)");
		assert.equal(await answer(new Response("not json", { status: 200 })), "server: The Mac sent something unexpected.");
	});
});

describe("the phone's storage (in memory)", () => {
	it("holds nothing until a deck is taken in", async () => {
		assert.equal(await createMemoryPhoneDb().load(), null);
	});

	it("replaces the cards on every deck, adds the Mac's review lines, and keeps what was answered on the phone", async () => {
		const db = createMemoryPhoneDb();
		await db.applyDeck({ meta: META, courses: [course("k1")], cards: [card("1"), card("2")], macReviews: [review("1", "2026-11-01T09:00:00.000Z")] });
		await db.addReviews([review("2", "2026-11-04T09:00:00.000Z")]);
		await db.applyDeck({ meta: { ...META, macReviews: 2 }, courses: [course("k1")], cards: [card("2")], macReviews: [review("1", "2026-11-02T09:00:00.000Z")] });
		const snap = (await db.load())!;
		assert.deepEqual(snap.cards.map((c) => c.id), ["2"]);
		assert.deepEqual(snap.reviews.map((r) => [r.src, r.sent]), [["mac", true], ["phone", false], ["mac", true]]);
		assert.equal(snap.meta.macReviews, 2);
	});

	it("keeps media by name, gives back only what it has, and forgets what is deleted", async () => {
		const db = createMemoryPhoneDb();
		await db.putMedia({ name: "a.png", mime: "image/png", bytes: PNG });
		await db.putMedia({ name: "b.mp3", mime: "audio/mpeg", bytes: PNG });
		assert.deepEqual((await db.mediaNames()).sort(), ["a.png", "b.mp3"]);
		assert.deepEqual([...(await db.getMedia(["a.png", "nope.png"])).keys()], ["a.png"]);
		await db.deleteMedia(["a.png"]);
		assert.deepEqual(await db.mediaNames(), ["b.mp3"]);
	});
});

describe("the study engine on the phone", () => {
	it("has nothing to study until a deck is taken in", async () => {
		assert.equal(await startPhoneEngine(createMemoryPhoneDb()), null);
	});

	it("lists courses, serves cards, takes answers and undoes them — without any network", async () => {
		globalThis.fetch = (async () => {
			throw new Error("the phone must not ask the Mac while studying");
		}) as typeof fetch;
		const engine = (await startPhoneEngine(await phoneWith([card("1"), card("2"), card("3")]), () => NOW))!;
		const list = await engine.api.courses();
		assert.deepEqual([list[0]!.id, list[0]!.total, list[0]!.counts.new], ["k1", 3, 3]);
		const first = await engine.api.next("k1", 0);
		assert.ok(first.card);
		const after = await engine.api.answer({ courseId: "k1", cardId: first.card!.id, grade: 3, ms: 800, step: first.step });
		assert.notEqual(after.card?.id, first.card!.id);
		const back = await engine.api.undo({ courseId: "k1", cardId: first.card!.id, step: first.step });
		assert.equal(back.card?.id, first.card!.id);
	});

	it("keeps every answer in storage, counts the ones the Mac does not have, and still has them after a restart", async () => {
		const db = await phoneWith([card("1"), card("2")], [review("1", "2026-10-30T09:00:00.000Z")]);
		const engine = (await startPhoneEngine(db, () => NOW))!;
		assert.equal(engine.unsent(), 0);
		const first = await engine.api.next("k1", 0);
		await engine.api.answer({ courseId: "k1", cardId: first.card!.id, grade: 4, ms: 500, step: first.step });
		assert.equal(engine.unsent(), 1);
		await engine.api.undo({ courseId: "k1", cardId: first.card!.id, step: first.step });
		assert.equal(engine.unsent(), 2, "an undo is a line too");

		const stored = (await db.load())!.reviews;
		assert.deepEqual(stored.map((r) => [r.src, r.sent]), [["mac", true], ["phone", false], ["phone", false]]);
		assert.equal(stored[1]!.review.cardId, first.card!.id);
		assert.equal(stored[1]!.review.grade, 4);
		assert.equal(stored[2]!.review.undo, true);

		const again = (await startPhoneEngine(db, () => NOW))!;
		assert.equal(again.unsent(), 2, "the count survives a restart");
	});

	it("shows a card's pictures from the phone's files, and a file it lacks as missing instead of failing", async () => {
		const db = await phoneWith([card("p", { fields: { Front: '<img src="arm.png"><img src="lost.png">', Back: "b" } })]);
		await db.putMedia({ name: "arm.png", mime: "image/png", bytes: PNG });
		const engine = (await startPhoneEngine(db, () => NOW))!;
		const out = await engine.api.next("k1", 0);
		assert.match(out.card!.front, /src="data:image\/png;base64,iVBORw==?"/);
		assert.doesNotMatch(out.card!.front, /src="arm\.png"/);
		assert.equal(out.step, 0, "the second look at the same card is not a new step");
		assert.equal((await db.load())!.reviews.length, 0, "and records nothing");
	});

	it("turns the engine's refusals into the screens' kind, and a storage failure into a message about this phone", async () => {
		const db = await phoneWith([card("1")]);
		const engine = (await startPhoneEngine(db, () => NOW))!;
		await assert.rejects(engine.api.next("nope", 0), (e) => e instanceof PhoneApiError && e.kind === "server");
		const first = await engine.api.next("k1", 0);
		db.addReviews = async () => {
			throw new Error("quota");
		};
		await assert.rejects(
			engine.api.answer({ courseId: "k1", cardId: first.card!.id, grade: 3, ms: 1, step: first.step }),
			(e) => e instanceof PhoneApiError && e.kind === "server" && /this phone/.test(e.message),
		);
	});

	it("writes a data: URI the browser can show, for big files too", () => {
		assert.equal(toDataUri("image/png", PNG), "data:image/png;base64,iVBORw==");
		const big = new Uint8Array(200_000).fill(65).buffer;
		assert.equal(toDataUri("text/plain", big).length, "data:text/plain;base64,".length + Math.ceil(200_000 / 3) * 4);
	});
});

describe("taking the Mac's deck onto the phone", () => {
	/** A Mac with these ledgers; it records what the phone asked for. */
	function mac(init: { cards: StudyCard[]; reviews?: StudyReview[]; media?: Record<string, ArrayBuffer>; failMedia?: string[]; down?: boolean }) {
		const asked: string[] = [];
		const store = createMemoryStudyStore({ courses: [course("k1")], cards: init.cards, reviews: init.reviews ?? [] });
		const files = init.media ?? {};
		globalThis.fetch = (async (input: unknown, request?: RequestInit) => {
			const url = String(input);
			asked.push(url);
			if (init.down) throw new TypeError("Failed to fetch");
			if (url === "/api/phone/sync" && request?.method === "POST") {
				return Response.json(acceptPhoneChanges(store, JSON.parse(String(request.body)) as { reviews?: unknown; ops?: unknown }));
			}
			if (url.startsWith("/api/phone/deck?reviewsFrom=")) {
				const from = Number(new URL(url, "http://x").searchParams.get("reviewsFrom"));
				return Response.json(buildPhoneDeck(store, (n) => (files[n] ? files[n]!.byteLength : null), from, NOW));
			}
			if (url.startsWith("/api/phone/media/")) {
				const name = decodeURIComponent(url.slice("/api/phone/media/".length));
				if (init.failMedia?.includes(name)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
				return new Response(files[name]!, { headers: { "content-type": name.endsWith(".mp3") ? "audio/mpeg" : "image/png" } });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
		return { asked, store };
	}
	const withPic = (id: string, ...names: string[]) => card(id, { fields: { Front: names.map((n) => `<img src="${n}">`).join(""), Back: "b" } });

	it("takes in the courses, cards, review lines and pictures, and says how far it is", async () => {
		const db = createMemoryPhoneDb();
		const { asked } = mac({
			cards: [withPic("1", "a.png", "my pic.png"), card("2")],
			reviews: [review("1", "2026-11-01T09:00:00.000Z"), review("2", "2026-11-02T09:00:00.000Z")],
			media: { "a.png": PNG, "my pic.png": PNG },
		});
		const progress: PullProgress[] = [];
		const result = await pullDeck(db, (p) => progress.push({ ...p }), () => NOW);
		assert.deepEqual(result, { cards: 2, courses: 1, reviews: 2, media: 2, mediaFailed: 0 });
		const snap = (await db.load())!;
		assert.deepEqual([snap.courses.length, snap.cards.length, snap.reviews.length], [1, 2, 2]);
		assert.deepEqual(snap.meta, { v: 1, deckAt: NOW.toISOString(), syncedAt: NOW.toISOString(), macReviews: 2 });
		assert.deepEqual((await db.mediaNames()).sort(), ["a.png", "my pic.png"]);
		assert.equal((await db.getMedia(["a.png"])).get("a.png")!.mime, "image/png");
		assert.ok(asked.includes("/api/phone/media/my%20pic.png"), "names are encoded in the address");
		assert.deepEqual(progress.at(0), { phase: "deck", done: 0, total: 1 });
		assert.deepEqual(progress.at(-1), { phase: "media", done: 2, total: 2 });
	});

	it("asks only for the review lines it does not have, fetches only new pictures, and drops pictures no card uses", async () => {
		const db = createMemoryPhoneDb();
		const first = mac({ cards: [withPic("1", "a.png", "b.png")], reviews: [review("1", "2026-11-01T09:00:00.000Z")], media: { "a.png": PNG, "b.png": PNG } });
		await pullDeck(db, undefined, () => NOW);
		assert.ok(first.asked.includes("/api/phone/deck?reviewsFrom=0"));

		const second = mac({
			cards: [withPic("1", "a.png", "c.png")],
			reviews: [review("1", "2026-11-01T09:00:00.000Z"), review("1", "2026-11-03T09:00:00.000Z")],
			media: { "a.png": PNG, "c.png": PNG },
		});
		const result = await pullDeck(db, undefined, () => NOW);
		assert.ok(second.asked.includes("/api/phone/deck?reviewsFrom=1"));
		assert.deepEqual(second.asked.filter((u) => u.startsWith("/api/phone/media/")), ["/api/phone/media/c.png"], "a.png is already on the phone");
		assert.deepEqual(result, { cards: 1, courses: 1, reviews: 1, media: 1, mediaFailed: 0 });
		assert.deepEqual((await db.mediaNames()).sort(), ["a.png", "c.png"], "b.png is gone");
		assert.equal((await db.load())!.reviews.length, 2);
	});

	it("does not count an answer twice when the Mac now holds the one this phone gave", async () => {
		const db = createMemoryPhoneDb();
		mac({ cards: [card("1")] });
		await pullDeck(db, undefined, () => NOW);
		const engine = (await startPhoneEngine(db, () => NOW))!;
		const shown = await engine.api.next("k1", 0);
		await engine.api.answer({ courseId: "k1", cardId: "1", grade: 3, ms: 1, step: shown.step });
		const mine = (await db.load())!.reviews[0]!.review;

		mac({ cards: [card("1")], reviews: [mine] });
		const result = await pullDeck(db, undefined, () => NOW);
		assert.equal(result.reviews, 0, "same card, time and grade: the same line");
		const snap = (await db.load())!;
		assert.equal(snap.reviews.length, 1);
		assert.equal(snap.meta.macReviews, 1, "the phone has now taken in the Mac's whole ledger");
	});

	it("skips a picture that will not come and says so; the next update tries it again", async () => {
		const db = createMemoryPhoneDb();
		mac({ cards: [withPic("1", "a.png", "b.png")], media: { "a.png": PNG, "b.png": PNG }, failMedia: ["b.png"] });
		const result = await pullDeck(db, undefined, () => NOW);
		assert.deepEqual([result.media, result.mediaFailed], [1, 1]);
		assert.deepEqual(await db.mediaNames(), ["a.png"]);
		mac({ cards: [withPic("1", "a.png", "b.png")], media: { "a.png": PNG, "b.png": PNG } });
		assert.deepEqual((await pullDeck(db, undefined, () => NOW)).media, 1);
		assert.deepEqual((await db.mediaNames()).sort(), ["a.png", "b.png"]);
	});

	it("keeps the cards it already took in when the connection drops during the pictures", async () => {
		const db = createMemoryPhoneDb();
		const files = { "a.png": PNG };
		const m = mac({ cards: [withPic("1", "a.png")], media: files });
		const real = globalThis.fetch;
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			if (String(input).startsWith("/api/phone/media/")) throw new TypeError("Failed to fetch");
			return real(input as RequestInfo, init);
		}) as typeof fetch;
		await assert.rejects(pullDeck(db, undefined, () => NOW), (e) => e instanceof PhoneApiError && e.kind === "unreachable");
		assert.equal((await db.load())!.cards.length, 1, "studying can start; the pictures come with the next update");
		assert.equal(m.asked.length > 0, true);
	});

	it("leaves the phone as it was when the Mac is down, locked it out, or sends something that is not a deck", async () => {
		const db = await phoneWith([card("old")]);
		mac({ cards: [card("new")], down: true });
		await assert.rejects(pullDeck(db, undefined, () => NOW), (e) => e instanceof PhoneApiError && e.kind === "unreachable");

		globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
		await assert.rejects(pullDeck(db, undefined, () => NOW), (e) => e instanceof PhoneApiError && e.kind === "unpaired");

		setPhoneToken("KEY");
		globalThis.fetch = (async () => Response.json({ v: 99 })) as typeof fetch;
		await assert.rejects(pullDeck(db, undefined, () => NOW), (e) => e instanceof PhoneApiError && e.kind === "server" && /unexpected/.test(e.message));

		assert.deepEqual((await db.load())!.cards.map((c) => c.id), ["old"]);
	});

	it("says the phone's storage is the problem when it cannot keep the cards", async () => {
		const db = createMemoryPhoneDb();
		db.applyDeck = async () => {
			throw new Error("QuotaExceededError");
		};
		mac({ cards: [card("1")] });
		await assert.rejects(pullDeck(db, undefined, () => NOW), (e) => e instanceof PhoneApiError && /its storage full/.test(e.message));
	});
});

describe("the phone's answers on their way to the Mac", () => {
	/** The same fake Mac as above, in this scope: a store the test can look into and the requests it got. */
	function macWith(cards: StudyCard[], reviews: StudyReview[] = []) {
		const store = createMemoryStudyStore({ courses: [course("k1")], cards, reviews });
		const posts: number[] = [];
		const asked: string[] = [];
		let down = false;
		globalThis.fetch = (async (input: unknown, request?: RequestInit) => {
			const url = String(input);
			asked.push(url);
			if (down) throw new TypeError("Failed to fetch");
			if (url === "/api/phone/sync") {
				const body = JSON.parse(String(request!.body)) as { reviews?: unknown[]; ops?: unknown[] };
				posts.push((body.reviews ?? body.ops ?? []).length);
				return Response.json(acceptPhoneChanges(store, body));
			}
			if (url.startsWith("/api/phone/deck?reviewsFrom=")) return Response.json(buildPhoneDeck(store, () => null, Number(new URL(url, "http://x").searchParams.get("reviewsFrom")), NOW));
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
		return { store, posts, asked, goDown: () => (down = true), comeUp: () => (down = false) };
	}
	const answered = async (db: PhoneDb, n: number) => {
		const engine = (await startPhoneEngine(db, () => NOW))!;
		for (let i = 0; i < n; i++) {
			const next = await engine.api.next("k1", i);
			await engine.api.answer({ courseId: "k1", cardId: next.card!.id, grade: 3, ms: 100, step: next.step });
		}
		return engine;
	};

	it("go in batches, are marked as sent once the Mac has them, and are not sent twice", async () => {
		const cards = Array.from({ length: 4 }, (_, i) => card(`c${i}`));
		const mac = macWith(cards);
		const db = await phoneWith(cards);
		await answered(db, 3);
		assert.equal((await db.unsentReviews()).length, 3);
		assert.equal((await pushChanges(db)).reviews, 3);
		assert.deepEqual(mac.posts, [3]);
		assert.equal(mac.store.readReviews().length, 3);
		assert.deepEqual(await db.unsentReviews(), []);
		assert.equal((await pushChanges(db)).reviews, 0);
		assert.deepEqual(mac.posts, [3], "nothing left, so the Mac is not even asked");
	});

	it("are split into batches of two thousand", async () => {
		const cards = [card("c1")];
		const mac = macWith(cards);
		const db = await phoneWith(cards);
		await db.addReviews(Array.from({ length: 4500 }, (_, i) => review("c1", new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString())));
		assert.equal((await pushChanges(db)).reviews, 4500);
		assert.deepEqual(mac.posts, [2000, 2000, 500]);
		assert.equal(mac.store.readReviews().length, 4500);
	});

	it("stay unsent when the Mac cannot be reached, and go the next time", async () => {
		const cards = [card("c1"), card("c2")];
		const mac = macWith(cards);
		const db = await phoneWith(cards);
		await answered(db, 2);
		mac.goDown();
		await assert.rejects(pushChanges(db), (e) => e instanceof PhoneApiError && e.kind === "unreachable");
		assert.equal((await db.unsentReviews()).length, 2);
		mac.comeUp();
		assert.equal((await pushChanges(db)).reviews, 2);
		assert.equal(mac.store.readReviews().length, 2);
	});

	it("are sent again without harm when the mark was lost: the Mac knows a line it holds", async () => {
		const cards = [card("c1")];
		const mac = macWith(cards);
		const db = await phoneWith(cards);
		await answered(db, 1);
		const lines = await db.unsentReviews();
		await pushChanges(db);
		await db.addReviews(lines);
		await pushChanges(db);
		assert.equal(mac.store.readReviews().length, 1);
	});

	it("are not marked as sent when the Mac answers with something that is not its sync answer", async () => {
		const db = await phoneWith([card("c1")]);
		await answered(db, 1);
		globalThis.fetch = (async () => Response.json({ hello: "world" })) as typeof fetch;
		await assert.rejects(pushChanges(db), (e) => e instanceof PhoneApiError && /unexpected/.test(e.message));
		assert.equal((await db.unsentReviews()).length, 1);
	});

	it("travel with the update: sent first, then the deck, and the phone ends up with nothing unsent", async () => {
		const cards = [card("c1"), card("c2")];
		const mac = macWith(cards, [review("c2", "2026-11-02T09:00:00.000Z")]);
		const db = await phoneWith(cards);
		const engine = await answered(db, 1);
		const source = sourceOver(db, engine);
		const progress: PullProgress[] = [];
		const { result, source: next } = await source.update((p) => progress.push({ ...p }));
		assert.equal(result.sent, 1);
		assert.equal(result.reviews, 1, "and the Mac's own answer came the other way");
		assert.equal(progress[0]!.phase, "send");
		assert.ok(mac.asked.indexOf("/api/phone/sync") < mac.asked.findIndex((u) => u.startsWith("/api/phone/deck")), "answers first");
		assert.equal(next.engine!.unsent(), 0);
		assert.equal(mac.store.readReviews().length, 2);
		assert.equal((await db.load())!.meta.macReviews, 2, "the Mac's ledger now holds its own line and the phone's");
		// a second update has nothing to send and says nothing about sending
		const again = await next.update((p) => progress.push({ ...p }));
		assert.equal(again.result.sent, 0);
		assert.deepEqual(mac.posts, [1]);
	});

	it("do not start the deck when they cannot be sent", async () => {
		const cards = [card("c1")];
		const mac = macWith(cards);
		const db = await phoneWith(cards);
		const engine = await answered(db, 1);
		mac.goDown();
		await assert.rejects(sourceOver(db, engine).update(() => {}), (e) => e instanceof PhoneApiError && e.kind === "unreachable");
		mac.comeUp();
		assert.ok(!mac.asked.some((u) => u.startsWith("/api/phone/deck")), "no deck request while the answers are stuck");
		assert.equal((await db.unsentReviews()).length, 1);
	});

	it("update with nothing to send does not announce sending, and the first run has no engine to ask", async () => {
		const mac = macWith([card("c1")]);
		const progress: PullProgress[] = [];
		const db = createMemoryPhoneDb();
		const { result } = await sourceOver(db, null).update((p) => progress.push({ ...p }));
		assert.equal(result.sent, 0);
		assert.ok(progress.every((p) => p.phase !== "send"));
		assert.ok(!mac.asked.includes("/api/phone/sync"));
	});

	it("survive the phone's storage being wiped: a backup file brings them back, once", async () => {
		const cards = [card("c1"), card("c2")];
		const db = await phoneWith(cards);
		const engine = await answered(db, 2);
		const file = JSON.parse(JSON.stringify(buildPhoneBackup(engine.unsentReviews(), NOW, "iPhone")));

		// a fresh phone with the deck but without those answers
		const fresh = await phoneWith(cards);
		const read = readPhoneBackup(file)!;
		const source = sourceOver(fresh, await startPhoneEngine(fresh, () => NOW));
		const restored = await source.restore(read.backup);
		assert.equal(restored.added, 2);
		assert.equal(restored.source.engine!.unsent(), 2);
		assert.equal((await restored.source.restore(read.backup)).added, 0, "reading the same file again adds nothing");

		// and the Mac takes them in exactly once, whichever way they come
		const mac = macWith(cards);
		const { result } = await restored.source.update(() => {});
		assert.equal(result.sent, 2);
		assert.equal(mac.store.readReviews().length, 2);
		assert.equal(acceptPhoneChanges(mac.store, { reviews: file.reviews })!.added, 0, "the backup read on the Mac afterwards adds nothing either");
	});

	it("are kept apart from what the Mac's ledger gave: reading a backup never turns a Mac line into an unsent one", async () => {
		const cards = [card("c1")];
		const macLine = review("c1", "2026-11-02T09:00:00.000Z");
		const db = await phoneWith(cards, [macLine]);
		const source = sourceOver(db, await startPhoneEngine(db, () => NOW));
		assert.equal((await source.restore({ reviews: [macLine] })).added, 0);
		assert.deepEqual(await db.unsentReviews(), []);
	});
});

describe("card changes made on the phone (Slice 10e)", () => {
	const AT = NOW.toISOString();
	const LATER = new Date(NOW.getTime() + 60 * 60_000);
	/** A Mac to talk to: the sync and the deck, on a store the test can look into. */
	function mac(cards: StudyCard[]) {
		const store = createMemoryStudyStore({ courses: [course("k1")], cards, reviews: [] });
		const asked: string[] = [];
		let down = false;
		globalThis.fetch = (async (input: unknown, request?: RequestInit) => {
			const url = String(input);
			asked.push(url);
			if (down) throw new TypeError("Failed to fetch");
			if (url === "/api/phone/sync") return Response.json(acceptPhoneChanges(store, JSON.parse(String(request!.body)) as { reviews?: unknown; ops?: unknown }));
			if (url.startsWith("/api/phone/deck?reviewsFrom=")) return Response.json(buildPhoneDeck(store, () => null, Number(new URL(url, "http://x").searchParams.get("reviewsFrom")), NOW));
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
		return { store, asked, goDown: () => (down = true), comeUp: () => (down = false), card: (id: string) => store.readCards().find((c) => c.id === id)! };
	}
	const act1 = (engine: NonNullable<Awaited<ReturnType<typeof startPhoneEngine>>>, cardId: string, action: "suspend" | "unsuspend" | "bury" | "unbury" | "edit", fields?: Record<string, string>) =>
		engine.api.cardAction({ courseId: "k1", cardId, action, fields, step: 0 });

	it("pausing a card takes it out of the queue, is written with the change itself, and is still there after a restart", async () => {
		const db = await phoneWith([card("c1"), card("c2")]);
		const engine = (await startPhoneEngine(db, () => NOW))!;
		const out = await act1(engine, "c1", "suspend");
		assert.equal(out.card?.id, "c2", "the next card is shown");
		const snap = (await db.load())!;
		assert.equal(snap.cards.find((c) => c.id === "c1")!.suspended, true);
		assert.equal(snap.cards.find((c) => c.id === "c1")!.editedAt, AT);
		assert.deepEqual(engine.unsentOps(), [{ cardId: "c1", action: "suspend", at: AT }]);
		assert.deepEqual(await db.unsentOps(), engine.unsentOps());
		const again = (await startPhoneEngine(db, () => NOW))!;
		assert.deepEqual(again.unsentOps(), engine.unsentOps(), "the change waits for the Mac after a restart");
		assert.equal((await again.api.next("k1", 0)).card?.id, "c2", "and the card stays paused");
	});

	it("burying hides the card until the next study day, and taking it back shows it again", async () => {
		const db = await phoneWith([card("c1"), card("c2")]);
		const engine = (await startPhoneEngine(db, () => NOW))!;
		assert.equal((await act1(engine, "c1", "bury")).card?.id, "c2");
		assert.equal((await db.load())!.cards.find((c) => c.id === "c1")!.buriedUntil, "2026-11-05");
		assert.equal((await act1(engine, "c1", "unbury")).card?.id, "c1");
		assert.deepEqual(engine.unsentOps().map((o) => o.action), ["bury", "unbury"]);
		assert.equal((await db.load())!.cards.find((c) => c.id === "c1")!.buriedUntil, undefined);
	});

	it("an edit rewrites the fields on the card and on the others of its note, and records only what was changed", async () => {
		const note = (id: string) => card(id, { origin: { kind: "anki-import", noteId: 9, deckName: "d" } as StudyCard["origin"], fields: { Front: "old", Back: "b" } });
		const db = await phoneWith([note("a"), note("b"), card("other")]);
		const engine = (await startPhoneEngine(db, () => NOW))!;
		await act1(engine, "a", "edit", { Front: "new" });
		const cards = (await db.load())!.cards;
		assert.deepEqual(cards.map((c) => c.fields.Front), ["new", "new", "Q-other"]);
		assert.equal(cards.find((c) => c.id === "b")!.editedAt, AT, "the sibling card is stamped too");
		assert.deepEqual(engine.unsentOps(), [{ cardId: "a", action: "edit", at: AT, fields: { Front: "new" } }]);
	});

	it("records nothing for an edit that changes nothing, and refuses what the engine refuses", async () => {
		const db = await phoneWith([card("c1")]);
		const engine = (await startPhoneEngine(db, () => NOW))!;
		await act1(engine, "c1", "edit", { Front: "Q-c1" });
		assert.deepEqual(engine.unsentOps(), []);
		await assert.rejects(act1(engine, "c1", "edit", { NoSuchField: "x" }), (e) => e instanceof PhoneApiError && /Unknown field/.test(e.message));
		await assert.rejects(act1(engine, "nope", "suspend"), (e) => e instanceof PhoneApiError && /Unknown card/.test(e.message));
		assert.deepEqual(await db.unsentOps(), []);
		assert.equal((await db.load())!.cards[0]!.editedAt, undefined);
	});

	it("goes to the Mac with the update, after the answers; the Mac's cards change, and the phone ends up with nothing unsent", async () => {
		const m = mac([card("c1"), card("c2")]);
		const db = await phoneWith([card("c1"), card("c2")]);
		const engine = (await startPhoneEngine(db, () => NOW))!;
		await act1(engine, "c1", "suspend");
		await act1(engine, "c2", "edit", { Front: "Edited on the phone" });
		const progress: PullProgress[] = [];
		const { result, source } = await sourceOver(db, engine).update((p) => progress.push({ ...p }));
		assert.deepEqual([result.sent, result.sentOps, result.newerOnMac], [0, 2, 0]);
		assert.equal(progress[0]!.phase, "send", "a phone with only card changes still says it is sending");
		assert.equal(m.card("c1").suspended, true);
		assert.equal(m.card("c1").editedAt, AT);
		assert.equal(m.card("c2").fields.Front, "Edited on the phone");
		assert.deepEqual([source.engine!.unsent(), source.engine!.unsentOps()], [0, []]);
		assert.ok(m.asked.indexOf("/api/phone/sync") < m.asked.findIndex((u) => u.startsWith("/api/phone/deck")));
		assert.deepEqual(await db.unsentOps(), []);
		assert.equal((await db.load())!.ops.length, 0, "the changes the Mac has are let go when its deck came in");
		// and again: nothing to send
		const again = await source.update(() => {});
		assert.equal(again.result.sentOps, 0);
	});

	it("is left out when the Mac changed the card after the learner did: the newer wins, and the Mac's version comes to the phone", async () => {
		const m = mac([card("c1", { editedAt: LATER.toISOString(), fields: { Front: "Mac wrote this", Back: "A-c1" } })]);
		const db = await phoneWith([card("c1")]);
		const engine = (await startPhoneEngine(db, () => NOW))!;
		await act1(engine, "c1", "edit", { Front: "Phone wrote this" });
		const { result, source } = await sourceOver(db, engine).update(() => {});
		assert.deepEqual([result.sentOps, result.newerOnMac], [1, 1]);
		assert.equal(m.card("c1").fields.Front, "Mac wrote this");
		assert.equal((await db.load())!.cards[0]!.fields.Front, "Mac wrote this", "the phone shows what the Mac has");
		assert.deepEqual(source.engine!.unsentOps(), []);
	});

	it("stays on the phone when the Mac cannot be reached, and the deck is not touched", async () => {
		const m = mac([card("c1")]);
		const db = await phoneWith([card("c1")]);
		const engine = (await startPhoneEngine(db, () => NOW))!;
		await act1(engine, "c1", "suspend");
		m.goDown();
		await assert.rejects(sourceOver(db, engine).update(() => {}), (e) => e instanceof PhoneApiError && e.kind === "unreachable");
		assert.equal((await db.unsentOps()).length, 1);
		assert.equal((await db.load())!.cards[0]!.suspended, true, "the card is still paused on the phone");
		m.comeUp();
		assert.equal((await pushChanges(db)).ops, 1);
		assert.equal(m.card("c1").suspended, true);
	});

	it("is sent again without harm when the mark was lost: the Mac knows a change it took in", async () => {
		const m = mac([card("c1")]);
		const db = await phoneWith([card("c1")]);
		const engine = (await startPhoneEngine(db, () => NOW))!;
		await act1(engine, "c1", "suspend");
		// the Mac takes the change in, but the phone never hears of it (the connection drops before the mark)
		const first = await pushChanges({ ...db, markOpsSent: async () => {} });
		assert.equal(first.cardChanges.applied, 1);
		assert.equal((await db.unsentOps()).length, 1, "still unsent here");
		const second = await pushChanges(db);
		assert.deepEqual([second.ops, second.cardChanges.known, second.cardChanges.applied], [1, 1, 0]);
		assert.equal(m.card("c1").editedAt, AT);
	});

	it("is not marked as sent when the Mac answers with something that is not its sync answer", async () => {
		const db = await phoneWith([card("c1")]);
		const engine = (await startPhoneEngine(db, () => NOW))!;
		await act1(engine, "c1", "suspend");
		globalThis.fetch = (async () => Response.json({ added: 0 })) as typeof fetch;
		await assert.rejects(pushChanges(db), (e) => e instanceof PhoneApiError && /unexpected/.test(e.message));
		assert.equal((await db.unsentOps()).length, 1);
	});

	it("survives the phone's storage being wiped: a backup file brings the changes back, once, and the Mac takes them in once", async () => {
		const db = await phoneWith([card("c1"), card("c2")]);
		const engine = (await startPhoneEngine(db, () => NOW))!;
		await act1(engine, "c1", "suspend");
		await act1(engine, "c2", "edit", { Back: "better" });
		const file = JSON.parse(JSON.stringify(buildPhoneBackup(engine.unsentReviews(), NOW, "iPhone", engine.unsentOps())));

		const fresh = await phoneWith([card("c1"), card("c2")]);
		const read = readPhoneBackup(file)!;
		const restored = await sourceOver(fresh, await startPhoneEngine(fresh, () => NOW)).restore(read.backup);
		assert.deepEqual([restored.added, restored.addedOps], [0, 2]);
		assert.equal((await restored.source.restore(read.backup)).addedOps, 0, "reading the same file again adds nothing");
		assert.equal(restored.source.engine!.unsentOps().length, 2);

		const m = mac([card("c1"), card("c2")]);
		const { result } = await restored.source.update(() => {});
		assert.equal(result.sentOps, 2);
		assert.equal(m.card("c1").suspended, true);
		assert.equal(m.card("c2").fields.Back, "better");
		assert.equal(acceptPhoneChanges(m.store, { ops: file.ops })!.cardChanges.known, 2, "the file read on the Mac afterwards adds nothing either");
	});

	it("keeps the changes the Mac does not have yet when a new deck comes in", async () => {
		const db = await phoneWith([card("c1")]);
		const engine = (await startPhoneEngine(db, () => NOW))!;
		await act1(engine, "c1", "suspend");
		await db.markOpsSent(await db.unsentOps());
		await act1(engine, "c1", "unsuspend");
		await db.applyDeck({ meta: META, courses: [course("k1")], cards: [card("c1")], macReviews: [] });
		assert.deepEqual((await db.load())!.ops.map((o) => [o.op.action, o.sent]), [["unsuspend", false]]);
	});
});
