/**
 * Lecture-context tests — deterministic, zero network, zero LLM:
 *
 *   1. the marker: what the model reads (curriculum-not-knowledge law, depth
 *      guide, every topic line, the pdf path), what the UI card gets (no
 *      path), the view projection and the input-cause class
 *   2. resolveLectureSelection: the request is untrusted — ids and depths in,
 *      stored outline text out
 *   3. POST /api/chats: the marker lands as message[0] ahead of the learner's
 *      first message, next to a graph pick, never on a practice session
 *   4. the doctrine fragments reach the prober's and teacher's prompts
 *
 * The data dir is a temp dir set BEFORE the first import of config.ts
 * (the LH_DATA_DIR seam is read at module load — see data-dir-seam.test.ts).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { textPdf, words } from "./fixtures/text-pdf.ts";
import type { LectureContextData, SessionLecture } from "../src/core/contracts.ts";
import type { LhMarkerMessage } from "../src/core/native-messages.ts";

let dir: string;
let service: typeof import("../src/server/library.ts");
let natives: typeof import("../src/core/native-messages.ts");
let view: typeof import("../src/core/view.ts");
let contracts: typeof import("../src/core/contracts.ts");

before(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-lecture-context-"));
	process.env.LH_DATA_DIR = dir;
	service = await import("../src/server/library.ts");
	natives = await import("../src/core/native-messages.ts");
	view = await import("../src/core/view.ts");
	contracts = await import("../src/core/contracts.ts");
});

after(() => {
	delete process.env.LH_DATA_DIR;
	fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	for (const sub of ["library", "chats"]) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
});

const TOPICS = [
	{ id: "t1", title: "Ion gradients", summary: "Concentration differences drive ion flow.", pageStart: 3, pageEnd: 6 },
	{ id: "t2", title: "Nernst equation", summary: "Equilibrium potential of one ion.", pageStart: 7, pageEnd: 9 },
	{ id: "t3", title: "Goldman equation", summary: "Resting potential from several permeant ions.", pageStart: 10, pageEnd: 14 },
];

/** A stored lecture with a finished outline. */
async function readyLecture(tag: string, title = "Membranes"): Promise<{ id: string; path: string }> {
	const { source } = await service.addLecture(`${title}.pdf`, textPdf([words(30, tag)], tag));
	const { libraryStore } = await import("../src/store/library.ts");
	libraryStore.update(source.id, { status: "ready", outline: { topics: TOPICS, generatedAt: new Date().toISOString() } });
	return { id: source.id, path: libraryStore.pdfPath(source.id)! };
}

function lecture(over: Partial<SessionLecture> = {}): SessionLecture {
	return {
		id: "lec_1",
		title: "Membranes",
		fileName: "Membranes.pdf",
		pages: 40,
		path: "/data/library/lec_1/source.pdf",
		topics: [
			{ ...TOPICS[0]!, depth: "overview" },
			{ ...TOPICS[2]!, depth: "derivation" },
		],
		...over,
	};
}

describe("lecture-context marker", () => {
	it("tells the model the lectures are curriculum, gives the depths, topics, pages and the pdf path", () => {
		const marker = natives.newLectureContextMessage([lecture()]);
		assert.equal(marker.role, "custom");
		assert.equal(marker.customType, "lecture-context");
		assert.match(marker.content, /^\[Session context\]/);
		assert.match(marker.content, /CURRICULUM/);
		assert.match(marker.content, /NOT evidence of what the learner already knows/);
		for (const depth of contracts.LECTURE_DEPTHS) assert.ok(marker.content.includes(contracts.LECTURE_DEPTH_GUIDE[depth]), `depth ${depth} explained`);
		assert.match(marker.content, /Lecture "Membranes" — 40 pages — read it with the pdf tool, path: \/data\/library\/lec_1\/source\.pdf/);
		assert.match(marker.content, /- \[t1\] Ion gradients \(pp\. 3-6\) — depth: overview — Concentration differences drive ion flow\./);
		assert.match(marker.content, /- \[t3\] Goldman equation \(pp\. 10-14\) — depth: derivation — /);
	});

	it("gives the UI card the lectures without their file paths", () => {
		const marker = natives.newLectureContextMessage([lecture()]);
		const details = marker.details as LectureContextData;
		assert.equal(details.lectures.length, 1);
		assert.equal(details.lectures[0]!.title, "Membranes");
		assert.equal(details.lectures[0]!.topics[1]!.depth, "derivation");
		assert.ok(!JSON.stringify(details).includes("source.pdf"), "no path in the UI payload");
	});

	it("projects to a user-side data part, and counts as neutral input", () => {
		const marker = natives.newLectureContextMessage([lecture()]);
		const projected = view.projectView([marker]);
		assert.equal(projected.length, 1);
		assert.equal(projected[0]!.role, "user");
		assert.equal(projected[0]!.parts[0]!.type, "data-lecture-context");
		assert.equal(natives.nativeInputCause(marker as never, []), "neutral");
	});

	it("flattens to a user message on the wire like every marker", () => {
		const marker = natives.newLectureContextMessage([lecture()]);
		const wire = natives.toLlmMessages([marker as never]);
		assert.equal(wire[0]?.role, "user");
		assert.ok(JSON.stringify(wire[0]).includes("CURRICULUM"));
	});
});

describe("resolveLectureSelection", () => {
	it("takes topic text, pages and title from the stored outline, never from the request", async () => {
		const { id, path: pdf } = await readyLecture("a");
		const [resolved] = service.resolveLectureSelection({
			lectures: [{ id, topics: [{ id: "t2", depth: "derivation", title: "HACKED", summary: "HACKED", pageStart: 1 }] }],
		});
		assert.equal(resolved?.id, id);
		assert.equal(resolved?.path, pdf);
		assert.deepEqual(resolved?.topics.map((t) => [t.id, t.title, t.pageStart, t.pageEnd, t.depth]), [["t2", "Nernst equation", 7, 9, "derivation"]]);
	});

	it("keeps outline page order, defaults a bad or missing depth, and drops repeats and unknown topics", async () => {
		const { id } = await readyLecture("b");
		const [resolved] = service.resolveLectureSelection({
			lectures: [{ id, topics: [{ id: "t3", depth: "overview" }, { id: "t1", depth: "nonsense" }, { id: "t1", depth: "derivation" }, { id: "t9" }, { id: "t2" }, { id: 7 }, null] }],
		});
		assert.deepEqual(resolved?.topics.map((t) => [t.id, t.depth]), [["t1", "mechanism"], ["t2", "mechanism"], ["t3", "overview"]]);
	});

	it("drops unknown lectures, lectures without a finished outline, hostile ids and repeats", async () => {
		const ready = await readyLecture("c");
		const { source: stored } = await service.addLecture("raw.pdf", textPdf([words(30, "d")], "d"));
		const picks = [{ id: "t1" }];
		const resolved = service.resolveLectureSelection({
			lectures: [
				{ id: "lec_missing", topics: picks },
				{ id: stored.id, topics: picks },
				{ id: "../graph", topics: picks },
				{ id: ready.id, topics: picks },
				{ id: ready.id, topics: picks },
				{ id: ready.id },
			],
		});
		assert.deepEqual(resolved.map((l) => l.id), [ready.id]);
	});

	it("returns nothing for garbage and caps the number of lectures", async () => {
		for (const garbage of [undefined, null, "x", 3, {}, { lectures: "x" }, { lectures: [] }]) {
			assert.deepEqual(service.resolveLectureSelection(garbage), []);
		}
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) ids.push((await readyLecture(`cap${i}`, `L${i}`)).id);
		const resolved = service.resolveLectureSelection({ lectures: ids.map((id) => ({ id, topics: [{ id: "t1" }] })) });
		assert.equal(resolved.length, 8);
	});
});

describe("POST /api/chats with a lecture pick", () => {
	const post = async (body: unknown) => {
		const route = await import("../app/api/chats/route.ts");
		const res = await route.POST(new Request("http://localhost/api/chats", { method: "POST", body: JSON.stringify(body) }));
		return (await res.json()) as { id: string };
	};
	const messagesOf = async (id: string) => (await import("../src/store/chats.ts")).chatStore.getChat(id)?.messages ?? [];

	it("puts the lecture marker first in the new session", async () => {
		const { id } = await readyLecture("e");
		const chat = await post({ title: "Membrane exam", lectureContext: { lectures: [{ id, topics: [{ id: "t2", depth: "derivation" }] }] } });
		const messages = await messagesOf(chat.id);
		assert.equal(messages.length, 1);
		const marker = messages[0] as LhMarkerMessage;
		assert.equal(marker.customType, "lecture-context");
		assert.match(marker.content, /\[t2\] Nernst equation \(pp\. 7-9\) — depth: derivation/);
	});

	it("keeps the graph pick first and the lecture pick right after it", async () => {
		const { id } = await readyLecture("f");
		const chat = await post({
			title: "Both",
			graphContext: { propositions: [{ id: "n1", name: "Diffusion", statement: "Particles spread down a gradient." }] },
			lectureContext: { lectures: [{ id, topics: [{ id: "t1" }] }] },
		});
		assert.deepEqual((await messagesOf(chat.id)).map((m) => (m as LhMarkerMessage).customType), ["graph-context", "lecture-context"]);
	});

	it("writes no marker for an empty or invalid pick, and none on a practice session", async () => {
		const { id } = await readyLecture("g");
		const pick = { lectures: [{ id, topics: [{ id: "t1" }] }] };
		assert.equal((await messagesOf((await post({ title: "A", lectureContext: { lectures: [] } })).id)).length, 0);
		assert.equal((await messagesOf((await post({ title: "B", lectureContext: { lectures: [{ id: "lec_missing", topics: [{ id: "t1" }] }] } })).id)).length, 0);
		assert.equal((await messagesOf((await post({ title: "C", kind: "practice", lectureContext: pick })).id)).length, 0);
	});
});

describe("lecture doctrine", () => {
	it("reaches the prober's and the teacher's composed prompts", async () => {
		const { listSourceSegments } = await import("../src/agent/prompt-segments.ts");
		const has = (agent: "prober" | "teacher", segment: string) => listSourceSegments(agent).some((s) => s.path === segment);
		assert.equal(has("prober", "prober/20-lecture-context.md"), true);
		assert.equal(has("teacher", "teacher/12-lecture-plan.md"), true);
		assert.equal(has("teacher", "prober/20-lecture-context.md"), false, "each agent keeps its own fragments");
		const text = (agent: "prober" | "teacher", segment: string) => fs.readFileSync(listSourceSegments(agent).find((s) => s.path === segment)!.file, "utf-8");
		assert.match(text("prober", "prober/20-lecture-context.md"), /never evidence of what he knows/);
		assert.match(text("teacher", "teacher/12-lecture-plan.md"), /not his knowledge/);
	});
});
