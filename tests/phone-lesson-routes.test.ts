/**
 * The phone's lesson routes (Learnbox 2.0, Slice 10f), on the real stores in a temp data dir: a lesson starts for a
 * course (from cards), is listed and read, and its turn wire (stream, turn, send, steer, dismiss) works — for study
 * lessons only; every other session of the Mac answers 404. LH_DATA_DIR is set BEFORE the first import.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { StudyCard, StudyCourse } from "../src/core/contracts/study.ts";

const NOW = new Date(2026, 10, 5, 19, 52, 7);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-lesson-routes-"));
process.env.LH_DATA_DIR = dir;

const course: StudyCourse = { id: "k1", name: "Anatomy", bufferDays: 5, createdAt: NOW.toISOString() };
const card = (id: string): StudyCard => ({ id, courseId: "k1", kind: "basic", fields: { Front: `Q-${id}`, Back: `A-${id}` }, tags: [], core: false, origin: { kind: "manual" }, createdAt: NOW.toISOString() });

const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const ctx = (p: { id: string; action: string }) => ({ params: Promise.resolve(p) });
const get = (url: string) => new Request(`http://test${url}`);
const post = (url: string, body: unknown) => new Request(`http://test${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

let start: typeof import("../app/api/phone/lesson/route.ts");
let list: typeof import("../app/api/phone/lessons/route.ts");
let record: typeof import("../app/api/phone/lesson/[id]/route.ts");
let wire: typeof import("../app/api/phone/lesson/[id]/[action]/route.ts");
let chats: typeof import("../src/server/chats.ts");
let lessonId: string;
let plainId: string;
let practiceId: string;

before(async () => {
	const { studyStore } = await import("../src/store/study.ts");
	studyStore.upsertCourse(course);
	studyStore.upsertCards([card("c1"), card("c2")]);
	chats = await import("../src/server/chats.ts");
	start = await import("../app/api/phone/lesson/route.ts");
	list = await import("../app/api/phone/lessons/route.ts");
	record = await import("../app/api/phone/lesson/[id]/route.ts");
	wire = await import("../app/api/phone/lesson/[id]/[action]/route.ts");
	plainId = chats.createChat("A session about something else").id;
	practiceId = chats.createChat("Practice", "practice", { courseId: "k1" }).id;
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("POST /api/phone/lesson", () => {
	it("starts a lesson for a course from cards: the first message names it, the cards ride as context", async () => {
		const res = await start.POST(post("/api/phone/lesson", { courseId: "k1", cardIds: ["c1"], title: "  Why is this the answer?  " }));
		assert.equal(res.status, 200);
		const made = (await res.json()) as { id: string; title: string };
		lessonId = made.id;
		assert.match(made.title, /Why is this the answer/);
		const chat = chats.getChat(lessonId)!;
		assert.equal(chat.courseId, "k1");
		assert.deepEqual(chat.cardIds, ["c1"]);
		assert.equal((chat.messages[0] as { customType?: string }).customType, "study-context", "the course context leads the record");
	});

	it("starts a lesson for a whole course, with no cards", async () => {
		const made = (await (await start.POST(post("/api/phone/lesson", { courseId: "k1", title: "Quiz me" }))).json()) as { id: string };
		assert.equal(chats.getChat(made.id)!.courseId, "k1");
		assert.equal(chats.getChat(made.id)!.cardIds?.length ?? 0, 0);
	});

	it("limits the lesson to the subdecks the phone holds: the marker names them and counts only their cards (Slice 10h)", async () => {
		const { studyStore } = await import("../src/store/study.ts");
		studyStore.upsertCards([{ ...card("t1"), topic: "W1" }, { ...card("t2"), topic: "W2" }, card("t3")]);
		const made = (await (await start.POST(post("/api/phone/lesson", { courseId: "k1", topics: ["W1", ""], title: "Only these" }))).json()) as { id: string };
		const marker = chats.getChat(made.id)!.messages[0] as { customType?: string; content: string; details: { subdecks?: string[]; newToday: number } };
		assert.equal(marker.customType, "study-context");
		assert.deepEqual(marker.details.subdecks, ["W1", ""]);
		assert.match(marker.content, /^Subdecks in this lesson: W1; no subdeck\.$/m);
		assert.equal(marker.details.newToday, 4, "t1 and t3, and the untouched c1 and c2 (no subdeck) — not t2 of W2");
		const plain = (await (await start.POST(post("/api/phone/lesson", { courseId: "k1", title: "All of it" }))).json()) as { id: string };
		const all = chats.getChat(plain.id)!.messages[0] as { content: string; details: { subdecks?: string[] } };
		assert.equal(all.details.subdecks, undefined);
		assert.ok(!all.content.includes("Subdecks in this lesson"));
		const junk = (await (await start.POST(post("/api/phone/lesson", { courseId: "k1", topics: "W1", title: "Not a list" }))).json()) as { id: string };
		assert.equal((chats.getChat(junk.id)!.messages[0] as { details: { subdecks?: string[] } }).details.subdecks, undefined, "something that is not a list limits nothing");
	});

	it("refuses what is not a lesson start, and never makes any other kind of session", async () => {
		for (const bad of [{}, { courseId: "k1" }, { title: "x" }, { courseId: "", title: "x" }, { courseId: "k1", title: "   " }, [], "not json {", null]) {
			const res = await start.POST(post("/api/phone/lesson", bad));
			assert.equal(res.status, 400, JSON.stringify(bad));
		}
		const before = chats.listChats().length;
		await start.POST(post("/api/phone/lesson", { courseId: "k1", title: "x", kind: "practice", graphContext: { propositions: [{ id: "n", name: "n", statement: "s" }] } }));
		const added = chats.listChats().slice(0, chats.listChats().length - before);
		assert.equal(chats.listChats().length, before + 1);
		assert.ok(added.every((c) => (c.kind ?? "teach") === "teach"));
	});

	it("passes the Mac's own refusals on: an unknown course or card is a 404, too many cards a 400", async () => {
		assert.equal((await start.POST(post("/api/phone/lesson", { courseId: "nope", title: "x" }))).status, 404);
		assert.equal((await start.POST(post("/api/phone/lesson", { courseId: "k1", cardIds: ["ghost"], title: "x" }))).status, 404);
		const many = Array.from({ length: 13 }, (_, i) => `c${i}`);
		assert.equal((await start.POST(post("/api/phone/lesson", { courseId: "k1", cardIds: many, title: "x" }))).status, 400);
	});
});

describe("GET /api/phone/lessons", () => {
	it("lists the course's study lessons only, with a few fields each", async () => {
		const out = (await (await list.GET(get("/api/phone/lessons?course=k1"))).json()) as { lessons: Array<Record<string, unknown>> };
		const ids = out.lessons.map((l) => l.id);
		assert.ok(ids.includes(lessonId));
		assert.ok(!ids.includes(plainId));
		assert.ok(!ids.includes(practiceId));
		assert.deepEqual(Object.keys(out.lessons[0]!).sort(), ["busy", "id", "pendingQuestion", "title", "updatedAt"]);
		assert.deepEqual((await (await list.GET(get("/api/phone/lessons?course=other"))).json()).lessons, []);
	});
	it("wants a course", async () => {
		assert.equal((await list.GET(get("/api/phone/lessons"))).status, 400);
	});
});

describe("the lesson gate", () => {
	it("reads a lesson's record", async () => {
		const res = await record.GET(get(`/api/phone/lesson/${lessonId}`), idCtx(lessonId));
		assert.equal(res.status, 200);
		const body = (await res.json()) as { id: string; messages: unknown[]; turnInFlight: boolean };
		assert.equal(body.id, lessonId);
		assert.equal(body.turnInFlight, false);
		assert.ok(body.messages.length >= 1);
	});

	it("answers 404 for a session that is no study lesson, one that does not exist and an id that is no id — on every route", async () => {
		for (const id of [plainId, practiceId, "chat_nope_00000000", "../x", "a b", ""]) {
			assert.equal((await record.GET(get("/x"), idCtx(id))).status, 404, `record ${id}`);
			for (const action of ["stream", "turn"]) assert.equal((await wire.GET(get("/x"), ctx({ id, action }))).status, 404, `${action} ${id}`);
			for (const action of ["send", "steer", "dismiss"]) assert.equal((await wire.POST(post("/x", { input: { type: "text", text: "hi" } }), ctx({ id, action }))).status, 404, `${action} ${id}`);
		}
	});

	it("never sends anything to a session that is no lesson", async () => {
		const before = JSON.stringify(chats.getChat(plainId));
		await wire.POST(post("/x", { input: { type: "text", text: "hello" } }), ctx({ id: plainId, action: "send" }));
		assert.equal(JSON.stringify(chats.getChat(plainId)), before);
	});

	it("knows only the listed actions", async () => {
		assert.equal((await wire.GET(get("/x"), ctx({ id: lessonId, action: "settings" }))).status, 404);
		assert.equal((await wire.POST(post("/x", {}), ctx({ id: lessonId, action: "stream" }))).status, 404);
		assert.equal((await wire.GET(get("/x"), ctx({ id: lessonId, action: "send" }))).status, 404);
	});
});

describe("a lesson's turn wire", () => {
	it("says whether a turn is running", async () => {
		assert.deepEqual(await (await wire.GET(get("/x"), ctx({ id: lessonId, action: "turn" }))).json(), { turnInFlight: false });
	});

	it("attaches to the stream: with no turn running it settles at once", async () => {
		const res = await wire.GET(get("/x"), ctx({ id: lessonId, action: "stream" }));
		assert.equal(res.status, 200);
		const text = await res.text();
		assert.match(text, /turn-settled/);
		assert.match(text, /\[DONE\]/);
	});

	it("refuses a steer when no turn is live, and a dismissal that targets no question", async () => {
		assert.equal((await wire.POST(post("/x", { input: { type: "steer", text: "more", id: "s1" } }), ctx({ id: lessonId, action: "steer" }))).status, 409);
		assert.equal((await wire.POST(post("/x", { input: { toolCallId: "nope" } }), ctx({ id: lessonId, action: "dismiss" }))).status, 400);
	});

	it("takes a sent input to the Mac's turn handler (the chat id comes from the address, not the body)", async () => {
		const bad = await wire.POST(post("/x", { chatId: plainId, input: { type: "nonsense" } }), ctx({ id: lessonId, action: "send" }));
		assert.equal(bad.status, 400);
		const before = JSON.stringify(chats.getChat(plainId));
		await wire.POST(post("/x", { chatId: plainId, input: { type: "text", text: "to the wrong chat" } }), ctx({ id: lessonId, action: "send" }));
		assert.equal(JSON.stringify(chats.getChat(plainId)), before, "a chatId in the body is ignored");
	});
});
