/**
 * Lecture library tests — deterministic, zero network, zero LLM:
 *
 *   1. store: add / list / get / update / pdfPath / remove, dedup by content
 *      hash, and every refusal (empty, not a PDF, too large)
 *   2. service: upload reads the page count; a PDF-looking file pdfjs cannot
 *      open is removed again (the library never keeps an unreadable lecture)
 *   3. routes: GET/POST /api/library and DELETE /api/library/:id, including
 *      a mixed upload where one bad file fails alone
 *
 * The data dir is a temp dir set BEFORE the first import of config.ts (the
 * LH_DATA_DIR seam is read at module load — see data-dir-seam.test.ts).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { LectureSource } from "../src/core/contracts.ts";
import { textPdf, words } from "./fixtures/text-pdf.ts";

/** The smallest PDF pdfjs opens: one blank page, xref left for pdfjs to rebuild. */
function tinyPdf(pages = 1, tag = ""): Uint8Array {
	const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ");
	const pageObjs = Array.from(
		{ length: pages },
		(_, i) => `${i + 3} 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>\nendobj\n`,
	).join("");
	const text =
		`%PDF-1.4\n%${tag}\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n` +
		`2 0 obj\n<</Type/Pages/Kids[${kids}]/Count ${pages}>>\nendobj\n${pageObjs}` +
		`trailer\n<</Root 1 0 R/Size ${pages + 3}>>\nstartxref\n0\n%%EOF\n`;
	return new TextEncoder().encode(text);
}

let dir: string;
let store: typeof import("../src/store/library.ts").libraryStore;
let service: typeof import("../src/server/library.ts");
let contracts: typeof import("../src/core/contracts.ts");

before(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-library-"));
	process.env.LH_DATA_DIR = dir;
	store = (await import("../src/store/library.ts")).libraryStore;
	service = await import("../src/server/library.ts");
	contracts = await import("../src/core/contracts.ts");
});

after(() => {
	delete process.env.LH_DATA_DIR;
	fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	fs.rmSync(path.join(dir, "library"), { recursive: true, force: true });
});

describe("library store", () => {
	it("stores a PDF with a derived title, a stamp and the bytes untouched", () => {
		const data = tinyPdf(1, "a");
		const { source, duplicate } = store.add({ fileName: "Lecture_03_Membranes.pdf", data });
		assert.equal(duplicate, false);
		assert.equal(source.v, contracts.LIBRARY_SCHEMA);
		assert.equal(source.title, "Lecture 03 Membranes");
		assert.equal(source.fileName, "Lecture_03_Membranes.pdf");
		assert.equal(source.status, "stored");
		assert.equal(source.pages, null);
		assert.equal(source.bytes, data.byteLength);
		const file = store.pdfPath(source.id);
		assert.ok(file);
		assert.deepEqual(new Uint8Array(fs.readFileSync(file)), data);
	});

	it("returns the existing source for identical bytes instead of storing twice", () => {
		const first = store.add({ fileName: "a.pdf", data: tinyPdf(1, "same") });
		const second = store.add({ fileName: "renamed.pdf", data: tinyPdf(1, "same") });
		assert.equal(second.duplicate, true);
		assert.equal(second.source.id, first.source.id);
		assert.equal(store.list().length, 1);
	});

	it("lists newest first and survives junk entries in the library dir", () => {
		const a = store.add({ fileName: "a.pdf", data: tinyPdf(1, "1") });
		store.update(a.source.id, {}); // no-op patch still rewrites cleanly
		const b = store.add({ fileName: "b.pdf", data: tinyPdf(1, "2") });
		fs.mkdirSync(path.join(dir, "library", "not a valid id"), { recursive: true });
		fs.mkdirSync(path.join(dir, "library", "empty_dir"), { recursive: true });
		const ids = store.list().map((s) => s.id);
		assert.deepEqual(new Set(ids), new Set([a.source.id, b.source.id]));
		assert.ok(store.list()[0]!.addedAt >= store.list()[1]!.addedAt);
	});

	it("update merges a patch but never touches identity fields", () => {
		const { source } = store.add({ fileName: "a.pdf", data: tinyPdf(1, "u") });
		const next = store.update(source.id, { pages: 12, status: "ready", title: "Biophysics 1" });
		assert.equal(next?.pages, 12);
		assert.equal(next?.title, "Biophysics 1");
		assert.equal(next?.id, source.id);
		assert.equal(next?.sha256, source.sha256);
		assert.equal(store.get(source.id)?.status, "ready");
		assert.equal(store.update("lec_unknown", { pages: 1 }), null);
	});

	it("refuses an empty file, a non-PDF and an oversized file with a coded error", () => {
		const code = (fn: () => unknown) => {
			try {
				fn();
			} catch (err) {
				assert.ok(err instanceof contracts.LibraryError);
				return err.code;
			}
			return "no error";
		};
		assert.equal(code(() => store.add({ fileName: "x.pdf", data: new Uint8Array(0) })), "empty");
		assert.equal(code(() => store.add({ fileName: "x.pdf", data: new TextEncoder().encode("hello") })), "not_pdf");
		const big = new Uint8Array(contracts.MAX_LECTURE_BYTES + 1);
		big.set(new TextEncoder().encode("%PDF-"));
		assert.equal(code(() => store.add({ fileName: "big.pdf", data: big })), "too_large");
		assert.equal(store.list().length, 0, "refused files leave nothing behind");
	});

	it("keeps only the base name of an uploaded file name", () => {
		const { source } = store.add({ fileName: "../../etc/passwd.pdf", data: tinyPdf(1, "p") });
		assert.equal(source.fileName, "passwd.pdf");
		assert.ok(store.pdfPath(source.id)?.startsWith(path.join(dir, "library")));
	});

	it("removes the folder, and reports an unknown id as false", () => {
		const { source } = store.add({ fileName: "a.pdf", data: tinyPdf(1, "r") });
		assert.equal(store.remove(source.id), true);
		assert.equal(store.get(source.id), null);
		assert.equal(store.pdfPath(source.id), null);
		assert.equal(store.remove(source.id), false);
	});

	it("never lets an id escape the library dir", () => {
		assert.equal(store.get("../graph"), null, "a hostile id reads as unknown");
		assert.throws(() => store.remove("../../x"), /Invalid lecture id/);
		assert.throws(() => store.pdfPath("../x"), /Invalid lecture id/);
	});

	it("ignores a record with a newer schema stamp", () => {
		const { source } = store.add({ fileName: "a.pdf", data: tinyPdf(1, "s") });
		const meta = path.join(dir, "library", source.id, "meta.json");
		const record = JSON.parse(fs.readFileSync(meta, "utf-8"));
		fs.writeFileSync(meta, JSON.stringify({ ...record, v: 99 }));
		assert.equal(store.get(source.id), null);
		assert.equal(store.list().length, 0);
	});
});

describe("library service", () => {
	it("reads the page count on upload", async () => {
		const { source, duplicate } = await service.addLecture("six.pdf", tinyPdf(6, "six"));
		assert.equal(duplicate, false);
		assert.equal(source.pages, 6);
		assert.equal(store.get(source.id)?.pages, 6);
	});

	it("returns a duplicate without reading it again", async () => {
		const first = await service.addLecture("a.pdf", tinyPdf(2, "dup"));
		const again = await service.addLecture("b.pdf", tinyPdf(2, "dup"));
		assert.equal(again.duplicate, true);
		assert.equal(again.source.id, first.source.id);
	});

	it("removes a PDF-looking file pdfjs cannot open", async () => {
		const junk = new TextEncoder().encode("%PDF-1.4\nthis is not a document at all\n");
		await assert.rejects(
			() => service.addLecture("broken.pdf", junk),
			(err: unknown) => err instanceof contracts.LibraryError && err.code === "unreadable",
		);
		assert.equal(service.listLectures().length, 0, "the unreadable upload is not kept");
	});
});

describe("library routes", () => {
	const upload = (files: Array<[string, Uint8Array | string]>) => {
		const form = new FormData();
		for (const [name, content] of files) form.append("files", new File([content as BlobPart], name, { type: "application/pdf" }));
		return new Request("http://localhost/api/library", { method: "POST", body: form });
	};

	it("POST stores good files, fails a bad one alone, and GET lists what landed", async () => {
		const route = await import("../app/api/library/route.ts");
		const res = await route.POST(upload([["good.pdf", tinyPdf(3, "route")], ["notes.txt", "plain text"]]));
		assert.equal(res.status, 200);
		const body = (await res.json()) as { results: Array<{ requestIndex: number; ok: boolean; code?: string; source?: { pages: number } }> };
		assert.equal(body.results.length, 2);
		assert.equal(body.results[0]!.ok, true);
		assert.equal(body.results[0]!.source?.pages, 3);
		assert.equal(body.results[1]!.ok, false);
		assert.equal(body.results[1]!.code, "not_pdf");

		const listed = (await (await route.GET()).json()) as { sources: Array<{ title: string }> };
		assert.deepEqual(listed.sources.map((s) => s.title), ["good"]);
	});

	it("POST without files answers 400", async () => {
		const route = await import("../app/api/library/route.ts");
		const res = await route.POST(new Request("http://localhost/api/library", { method: "POST", body: new FormData() }));
		assert.equal(res.status, 400);
	});

	it("DELETE removes a lecture (204), then 404, and 404 for a hostile id", async () => {
		const route = await import("../app/api/library/route.ts");
		const item = await import("../app/api/library/[id]/route.ts");
		const res = await route.POST(upload([["gone.pdf", tinyPdf(1, "del")]]));
		const { results } = (await res.json()) as { results: Array<{ source: { id: string } }> };
		const id = results[0]!.source.id;
		const del = (target: string) => item.DELETE(new Request("http://localhost"), { params: Promise.resolve({ id: target }) });
		assert.equal((await del(id)).status, 204);
		assert.equal((await del(id)).status, 404);
		assert.equal((await del("../graph")).status, 404);
		assert.equal(fs.existsSync(path.join(dir, "graph")), false, "nothing outside the library was touched");
	});
});

describe("library outline runs", () => {
	const fauxEngine = (steps: FauxResponseStep[]): PiEngine => {
		const faux = createFauxCore({});
		faux.setResponses(steps);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	};
	const submitMessage = (topics: unknown[]) =>
		fauxAssistantMessage([fauxToolCall("submit_topics", { topics } as unknown as ToolCall["arguments"], { id: "c" })], { stopReason: "toolUse" });
	const submitTopics = (topics: unknown[]): FauxResponseStep => () => submitMessage(topics);
	/** Start a run and wait until it settles. */
	const runOutline = (id: string, engine: PiEngine) =>
		new Promise<LectureSource | null>((resolve) => {
			const started = service.startOutline(id, { engine, onSettled: resolve });
			assert.ok(started);
			assert.equal(started.status, "outlining", "the call returns at once with the running record");
		});

	it("a finished run stores the outline, clears progress and marks the lecture ready", async () => {
		const { source } = await service.addLecture("bio.pdf", textPdf([words(30, "a"), words(30, "b")], "ok"));
		const done = await runOutline(source.id, fauxEngine([submitTopics([{ title: "Diffusion", summary: "Fick's laws.", pageStart: 1, pageEnd: 2 }])]));
		assert.equal(done?.status, "ready");
		assert.equal(done?.outline?.topics[0]?.title, "Diffusion");
		assert.equal(done?.progress, undefined);
		assert.equal(done?.error, undefined);
		assert.equal(service.getLecture(source.id)?.outline?.topics.length, 1);
	});

	it("a failed run keeps the lecture, records why, and can be started again", async () => {
		const { source } = await service.addLecture("bio.pdf", textPdf([words(30, "a")], "fail"));
		const never = fauxEngine([() => fauxAssistantMessage("I will not call the tool.")]);
		const failed = await runOutline(source.id, never);
		assert.equal(failed?.status, "failed");
		assert.match(failed?.error ?? "", /never submitted/);
		assert.equal(failed?.progress, undefined);
		const retried = await runOutline(source.id, fauxEngine([submitTopics([{ title: "Retry", summary: "s", pageStart: 1, pageEnd: 1 }])]));
		assert.equal(retried?.status, "ready");
		assert.equal(retried?.error, undefined, "a successful rerun clears the old error");
	});

	it("a re-run replaces the outline of a ready lecture", async () => {
		const { source } = await service.addLecture("bio.pdf", textPdf([words(30, "a"), words(30, "b")], "rerun"));
		await runOutline(source.id, fauxEngine([submitTopics([{ title: "First pass", summary: "s", pageStart: 1, pageEnd: 2 }])]));
		const again = await runOutline(source.id, fauxEngine([submitTopics([
			{ title: "Second pass A", summary: "s", pageStart: 1, pageEnd: 1 },
			{ title: "Second pass B", summary: "s", pageStart: 2, pageEnd: 2 },
		])]));
		assert.equal(again?.status, "ready");
		assert.deepEqual(again?.outline?.topics.map((t) => t.title), ["Second pass A", "Second pass B"]);
	});

	it("a failed re-run keeps the previous outline and the lecture stays ready, with the failure noted", async () => {
		const { source } = await service.addLecture("bio.pdf", textPdf([words(30, "a")], "rerunfail"));
		await runOutline(source.id, fauxEngine([submitTopics([{ title: "Kept", summary: "s", pageStart: 1, pageEnd: 1 }])]));
		const failed = await runOutline(source.id, fauxEngine([() => fauxAssistantMessage("No tool call this time.")]));
		assert.equal(failed?.status, "ready", "still usable for sessions");
		assert.equal(failed?.outline?.topics[0]?.title, "Kept");
		assert.match(failed?.error ?? "", /previous outline is kept.*never submitted/);
		assert.equal(failed?.progress, undefined);
		// and the next good run clears the note
		const ok = await runOutline(source.id, fauxEngine([submitTopics([{ title: "Fresh", summary: "s", pageStart: 1, pageEnd: 1 }])]));
		assert.equal(ok?.error, undefined);
		assert.equal(ok?.outline?.topics[0]?.title, "Fresh");
	});

	it("an interrupted re-run leaves a ready lecture with its outline, not a failed one", async () => {
		const { source } = await service.addLecture("bio.pdf", textPdf([words(30, "a")], "rerunstale"));
		await runOutline(source.id, fauxEngine([submitTopics([{ title: "Kept", summary: "s", pageStart: 1, pageEnd: 1 }])]));
		store.update(source.id, { status: "outlining", progress: { done: 0, total: 1 } });
		const listed = service.listLectures().find((s) => s.id === source.id);
		assert.equal(listed?.status, "ready");
		assert.equal(listed?.outline?.topics[0]?.title, "Kept");
		assert.match(listed?.error ?? "", /interrupted/);
	});

	it("returns the running record for a second start and null for an unknown id", async () => {
		const { source } = await service.addLecture("bio.pdf", textPdf([words(30, "a")], "twice"));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const slow = fauxEngine([
			async () => {
				await gate;
				return submitMessage([{ title: "Slow", summary: "s", pageStart: 1, pageEnd: 1 }]);
			},
		]);
		const settled = new Promise<LectureSource | null>((resolve) => service.startOutline(source.id, { engine: slow, onSettled: resolve }));
		const again = service.startOutline(source.id, { engine: slow });
		assert.equal(again?.status, "outlining");
		assert.equal(service.startOutline("lec_missing"), null);
		release();
		assert.equal((await settled)?.status, "ready");
	});

	it("reports an outlining record with no live run as interrupted", async () => {
		const { source } = await service.addLecture("bio.pdf", textPdf([words(30, "a")], "stale"));
		store.update(source.id, { status: "outlining", progress: { done: 1, total: 3 } });
		const listed = service.listLectures().find((s) => s.id === source.id);
		assert.equal(listed?.status, "failed");
		assert.match(listed?.error ?? "", /interrupted/);
		assert.equal(listed?.progress, undefined);
		assert.equal(store.get(source.id)?.status, "failed", "the correction is persisted");
	});

	it("deleting a lecture mid-run aborts it and leaves nothing behind", async () => {
		const { source } = await service.addLecture("bio.pdf", textPdf([words(30, "a")], "abort"));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const slow = fauxEngine([
			async () => {
				await gate;
				return submitMessage([{ title: "Late", summary: "s", pageStart: 1, pageEnd: 1 }]);
			},
		]);
		const settled = new Promise<LectureSource | null>((resolve) => service.startOutline(source.id, { engine: slow, onSettled: resolve }));
		assert.equal(service.removeLecture(source.id), true);
		release();
		assert.equal(await settled, null, "the record is gone and the late result wrote nothing");
		assert.equal(store.list().length, 0);
	});

	it("POST /outline answers 404 for an unknown lecture and 503 when no model is set up", async () => {
		const outline = await import("../app/api/library/[id]/outline/route.ts");
		const post = (id: string) => outline.POST(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id }) });
		assert.equal((await post("lec_missing")).status, 404);
		assert.equal((await post("../graph")).status, 404);
		const { source } = await service.addLecture("bio.pdf", textPdf([words(30, "a")], "nomodel"));
		const res = await post(source.id);
		assert.equal(res.status, 503);
		assert.equal(((await res.json()) as { code: string }).code, "models_not_configured");
		assert.equal(store.get(source.id)?.status, "stored", "a refused start leaves the lecture untouched");
	});

	it("GET /api/library/:id returns one lecture, 404 otherwise", async () => {
		const item = await import("../app/api/library/[id]/route.ts");
		const { source } = await service.addLecture("bio.pdf", textPdf([words(30, "a")], "get"));
		const get = (id: string) => item.GET(new Request("http://localhost"), { params: Promise.resolve({ id }) });
		const res = await get(source.id);
		assert.equal(res.status, 200);
		assert.equal(((await res.json()) as { source: { id: string } }).source.id, source.id);
		assert.equal((await get("lec_missing")).status, 404);
	});
});
