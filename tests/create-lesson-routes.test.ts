/**
 * Cards from a lesson, through the routes (Slice 9c) — the real stores in a temp data dir, a scripted model:
 * the statement list of a lesson, making a job, its detail, editing and selecting drafts, adopting them, and the
 * ways back (the lesson knows its cards, the cards that share a draft are siblings).
 *
 * The data dir is a temp dir set BEFORE the first import of config.ts (LH_DATA_DIR is read at module load).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AskClaude } from "../src/agent/claude-ask.ts";
import type { CreateJobSummary, GraphNode, LessonJobDetail, LessonSource } from "../src/core/contracts.ts";

const NOW = new Date(2026, 10, 5, 10, 0, 0);

let dir = "";
let stores: typeof import("../src/server/stores.ts");
let lesson: typeof import("../src/server/create-lesson.ts");
let chatId = "";

const node = (id: string, name: string, statement: string, ...chats: string[]): GraphNode => ({
	id,
	name,
	statement,
	aliases: [],
	createdAt: NOW.toISOString(),
	provenance: chats.map((c) => ({ chatId: c, messageId: "m1" })),
});

/** The model answers each statement with one question and one two-gap sentence. */
const scripted: AskClaude = async () => ({
	text: JSON.stringify({
		cards: [
			{ type: "basic", front: "Which nerve passes through the carpal tunnel?", back: "The median nerve." },
			{ type: "cloze", text: "The {{c1::median nerve}} runs with {{c2::nine tendons}}." },
		],
	}),
	costUsd: 0,
	durationMs: 1,
});

before(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "create-lesson-routes-"));
	process.env.LH_DATA_DIR = dir;
	stores = await import("../src/server/stores.ts");
	lesson = await import("../src/server/create-lesson.ts");
});

after(() => {
	delete process.env.LH_DATA_DIR;
	fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	for (const sub of ["study", "chats", "graph", "create"]) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
	stores.stores.studyStore.upsertCourse({ id: "anat", name: "Anatomy", topics: ["Arm"], bufferDays: 5, createdAt: NOW.toISOString() });
	chatId = stores.stores.chatStore.createChat("Wrist nerves", undefined, { courseId: "anat" }).id;
	const other = stores.stores.chatStore.createChat("Elsewhere").id;
	stores.stores.graphStore.appendNode(node("n_median", "Median nerve", "The median nerve passes through the carpal tunnel.", chatId));
	stores.stores.graphStore.appendNode(node("n_ulnar", "Ulnar nerve", "The ulnar nerve passes through Guyon's canal.", chatId, other));
	stores.stores.graphStore.appendNode(node("n_femoral", "Femoral nerve", "The femoral nerve supplies the quadriceps.", other));
});

const call = async <T = Record<string, unknown>>(handler: Promise<Response> | Response): Promise<{ status: number; body: T }> => {
	const res = await handler;
	return { status: res.status, body: (await res.json().catch(() => null)) as T };
};
const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const idParams = <T extends object>(p: T) => ({ params: Promise.resolve(p) });

async function source(query: string) {
	const route = await import("../app/api/create/lesson-source/route.ts");
	return call<LessonSource & { error?: string }>(route.GET(new Request(`http://localhost/api/create/lesson-source?${query}`)));
}

async function makeJob(over: object = {}) {
	const route = await import("../app/api/create/jobs/route.ts");
	return call<{ job: CreateJobSummary; error?: string }>(
		route.POST(new Request("http://localhost/api/create/jobs", json("POST", { kind: "lesson", chatId, statementIds: ["n_median", "n_ulnar"], courseId: "anat", autostart: false, ...over }))),
	);
}

/** Run the job's statements with the scripted model on the live stores. */
async function runIt(id: string) {
	await lesson.startLessonJob(id, {}, { ...lesson.defaultLessonDeps(), ask: scripted, retryDelayMs: 0 }).settled;
}

async function detail(id: string) {
	const route = await import("../app/api/create/jobs/[id]/route.ts");
	return (await call<LessonJobDetail>(route.GET(new Request("http://localhost/x"), idParams({ id })))).body;
}

describe("the statements of a lesson", () => {
	it("lists what the lesson touched, with the lesson's title and course", async () => {
		const { status, body } = await source(`chat=${chatId}`);
		assert.equal(status, 200);
		assert.equal(body.title, "Wrist nerves");
		assert.equal(body.courseId, "anat");
		assert.deepEqual(body.statements.map((s) => [s.nodeId, s.cards]), [["n_median", 0], ["n_ulnar", 0]]);
	});

	it("lists picked nodes, and says no for a lesson or a pick that does not exist", async () => {
		assert.deepEqual((await source("nodes=n_femoral,n_median")).body.statements.map((s) => s.nodeId), ["n_median", "n_femoral"]);
		assert.equal((await source("chat=nope")).status, 404);
		assert.equal((await source("nodes=n_gone")).status, 404);
		assert.equal((await source("")).status, 400);
	});
});

describe("making a job", () => {
	it("makes a lesson job and shows it in the list and in its detail", async () => {
		const { status, body } = await makeJob();
		assert.equal(status, 200);
		assert.equal(body.job.kind, "lesson");
		assert.equal(body.job.courseId, "anat");
		assert.equal(body.job.chatId, chatId);

		const list = await import("../app/api/create/jobs/route.ts");
		assert.deepEqual(((await (await list.GET()).json()) as { jobs: CreateJobSummary[] }).jobs.map((j) => j.id), [body.job.id]);

		const d = await detail(body.job.id);
		assert.deepEqual(d.pages.map((p) => [p.page, p.statement.nodeId, p.status]), [[1, "n_median", "pending"], [2, "n_ulnar", "pending"]]);
		assert.equal(d.chatId, chatId);
	});

	it("refuses the requests that cannot make one — cleanly", async () => {
		assert.equal((await makeJob({ courseId: "nope" })).status, 404);
		assert.equal((await makeJob({ statementIds: [] })).status, 400);
		assert.equal((await makeJob({ statementIds: ["n_femoral"] })).status, 404); // not a statement of this lesson
		assert.equal((await makeJob({ chatId: "nope" })).status, 404);
		assert.equal((await makeJob({ chatId: undefined, nodeIds: undefined })).status, 400);
	});
});

describe("from drafts to cards", () => {
	it("edits, selects and adopts; the cards are core knowledge tied to their statements and the lesson knows them", async () => {
		const { body } = await makeJob();
		const id = body.job.id;
		await runIt(id);
		assert.equal((await detail(id)).job.drafts, 4);

		const patch = await import("../app/api/create/jobs/[id]/cards/[cid]/route.ts");
		const edited = await call<{ card: { front: string; edited: boolean } }>(patch.PATCH(new Request("http://localhost/x", json("PATCH", { front: "Edited question" })), idParams({ id, cid: "p001-c01" })));
		assert.deepEqual([edited.status, edited.body.card.front, edited.body.card.edited], [200, "Edited question", true]);
		assert.equal((await call(patch.PATCH(new Request("http://localhost/x", json("PATCH", { back: "" })), idParams({ id, cid: "p001-c01" })))).status, 400);

		const include = await import("../app/api/create/jobs/[id]/include/route.ts");
		const out = await call<{ changed: number }>(include.POST(new Request("http://localhost/x", json("POST", { cardIds: ["p002-c01", "p002-c02"], include: false })), idParams({ id })));
		assert.equal(out.body.changed, 2);

		const adopt = await import("../app/api/create/jobs/[id]/adopt/route.ts");
		const adopted = await call<{ adopted: number }>(adopt.POST(new Request("http://localhost/x", json("POST", { courseId: "anat" })), idParams({ id })));
		assert.equal(adopted.body.adopted, 2); // statement 1 only

		const cards = stores.stores.studyStore.readCards();
		assert.equal(cards.length, 3); // one basic + a cloze with two gaps
		assert.ok(cards.every((c) => c.core && c.tier === 1 && c.courseId === "anat" && c.origin.kind === "graph" && c.origin.nodeId === "n_median"));
		assert.equal(cards.find((c) => c.kind === "basic")!.fields.Front, "Edited question");

		const chat = stores.stores.chatStore.getChat(chatId)!;
		assert.deepEqual([...(chat.madeCardIds ?? [])].sort(), cards.map((c) => c.id).sort());
		assert.deepEqual([...(stores.stores.chatStore.listChats().find((c) => c.id === chatId)?.madeCardIds ?? [])].sort(), cards.map((c) => c.id).sort());

		// the other statement is still a draft; it adopts later, and the lesson learns of those cards too
		const later = await call<{ adopted: number }>(adopt.POST(new Request("http://localhost/x", json("POST", { courseId: "anat", cardIds: ["p002-c01"] })), idParams({ id })));
		assert.equal(later.body.adopted, 1);
		assert.equal(stores.stores.chatStore.getChat(chatId)!.madeCardIds!.length, 4);
	});

	it("the cards of one cloze draft are siblings in the review, and a card opens by its id", async () => {
		const { body } = await makeJob({ statementIds: ["n_median"] });
		await runIt(body.job.id);
		const adopt = await import("../app/api/create/jobs/[id]/adopt/route.ts");
		await adopt.POST(new Request("http://localhost/x", json("POST", { courseId: "anat" })), idParams({ id: body.job.id }));

		const next = await import("../app/api/study/next/route.ts");
		const cloze = stores.stores.studyStore.readCards().find((c) => c.kind === "cloze" && c.variant === 0)!;
		const shown = await call<{ card: { id: string; siblings: number } }>(next.GET(new Request(`http://localhost/api/study/next?course=anat&step=0&card=${cloze.id}`)));
		assert.equal(shown.body.card.id, cloze.id);
		assert.equal(shown.body.card.siblings, 1);
	});

	it("a statement that has cards says so in the next list, and the job can be deleted", async () => {
		const { body } = await makeJob();
		await runIt(body.job.id);
		const adopt = await import("../app/api/create/jobs/[id]/adopt/route.ts");
		await adopt.POST(new Request("http://localhost/x", json("POST", { courseId: "anat" })), idParams({ id: body.job.id }));
		assert.deepEqual((await source(`chat=${chatId}`)).body.statements.map((s) => [s.nodeId, s.cards]), [["n_median", 3], ["n_ulnar", 3]]);

		const route = await import("../app/api/create/jobs/[id]/route.ts");
		assert.equal((await route.DELETE(new Request("http://localhost/x"), idParams({ id: body.job.id }))).status, 204);
		assert.equal(stores.stores.studyStore.readCards().length, 6, "the cards stay when the job goes");
	});
});

describe("the lesson remembers its cards", () => {
	it("adds the ids once each, leaves the order of the list alone, and knows no stranger", async () => {
		const chats = stores.stores.chatStore;
		const before = chats.getChat(chatId)!.updatedAt;
		chats.linkCards(chatId, []); // nothing to add: nothing written
		assert.equal(chats.getChat(chatId)!.madeCardIds, undefined);
		chats.linkCards(chatId, ["a", "b"]);
		chats.linkCards(chatId, ["b", "c"]);
		const record = chats.getChat(chatId)!;
		assert.deepEqual(record.madeCardIds, ["a", "b", "c"]);
		assert.equal(record.updatedAt, before, "not conversation activity");
		assert.equal(chats.linkCards("c_nope", ["a"]), null);
	});
});
