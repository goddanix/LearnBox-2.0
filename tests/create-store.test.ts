/**
 * CreateStore adapter tests (src/store/create.ts) against a throw-away temp
 * dir through createCreateStore(root) — never data/create.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { CREATE_SCHEMA, DEFAULT_LESSON_SETTINGS, DEFAULT_MCQ_SETTINGS, type CreateJob, type LessonPageResult, type McqPageResult } from "../src/core/contracts.ts";
import type { CreateStore } from "../src/core/ports.ts";
import { createCreateStore } from "../src/store/create.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-store-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let dir: string;
let store: CreateStore;
let n = 0;
beforeEach(() => {
	dir = path.join(root, `case${++n}`);
	store = createCreateStore(dir);
});

const job = (id: string, createdAt: string): CreateJob => ({
	v: CREATE_SCHEMA,
	id,
	kind: "mcq",
	name: `Job ${id}`,
	lectureId: "lec1",
	nPages: 2,
	settings: { ...DEFAULT_MCQ_SETTINGS, pageTo: 2 },
	state: "queued",
	createdAt,
	pages: { "1": { status: "pending", count: 0, adopted: 0 }, "2": { status: "pending", count: 0, adopted: 0 } },
});

const page = (p: number): McqPageResult => ({
	page: p,
	questions: [
		{
			id: `p${String(p).padStart(3, "0")}-q01`,
			page: p,
			question: "Q?",
			options: { A: "a", B: "b", C: "c", D: "d" },
			correct: ["A"],
			explanation: "x",
			deleted: false,
		},
	],
});

describe("create store", () => {
	it("reads an empty store as empty", () => {
		assert.deepEqual(store.list(), []);
		assert.equal(store.get("crt_x"), null);
		assert.equal(store.readPage("crt_x", 1), null);
	});

	it("round-trips a job and lists the newest first", () => {
		store.createJob(job("crt_a", "2026-11-04T08:00:00.000Z"));
		store.createJob(job("crt_b", "2026-11-04T09:00:00.000Z"));
		assert.deepEqual(store.get("crt_a"), job("crt_a", "2026-11-04T08:00:00.000Z"));
		assert.deepEqual(store.list().map((j) => j.id), ["crt_b", "crt_a"]);
	});

	it("updates a job in place and leaves no temp file behind", () => {
		store.createJob(job("crt_a", "2026-11-04T08:00:00.000Z"));
		const updated = store.update("crt_a", (j) => {
			j.state = "running";
			j.pages["1"]!.status = "done";
		});
		assert.equal(updated?.state, "running");
		assert.equal(store.get("crt_a")?.pages["1"]?.status, "done");
		assert.equal(store.update("crt_missing", () => {}), null);
		assert.deepEqual(fs.readdirSync(path.join(dir, "crt_a")), ["job.json"]);
	});

	it("keeps one result file per page", () => {
		store.createJob(job("crt_a", "2026-11-04T08:00:00.000Z"));
		store.writePage("crt_a", page(2));
		assert.deepEqual(store.readPage("crt_a", 2), page(2));
		assert.equal(store.readPage("crt_a", 1), null);
		store.writePage("crt_a", { page: 2, questions: [] });
		assert.deepEqual(store.readPage("crt_a", 2)?.questions, []);
	});

	it("refuses a newer schema stamp and a record under the wrong id", () => {
		store.createJob(job("crt_a", "2026-11-04T08:00:00.000Z"));
		fs.writeFileSync(path.join(dir, "crt_a", "job.json"), JSON.stringify({ ...job("crt_a", "x"), v: CREATE_SCHEMA + 1 }));
		assert.equal(store.get("crt_a"), null);
		assert.deepEqual(store.list(), []);

		fs.mkdirSync(path.join(dir, "crt_b"));
		fs.writeFileSync(path.join(dir, "crt_b", "job.json"), JSON.stringify(job("crt_other", "x")));
		assert.equal(store.get("crt_b"), null);
	});

	it("skips damaged files instead of failing the list", () => {
		store.createJob(job("crt_a", "2026-11-04T08:00:00.000Z"));
		fs.mkdirSync(path.join(dir, "crt_broken"));
		fs.writeFileSync(path.join(dir, "crt_broken", "job.json"), "{ not json");
		store.writePage("crt_a", page(1));
		fs.writeFileSync(path.join(dir, "crt_a", "results", "p001.json"), "{ torn");
		assert.deepEqual(store.list().map((j) => j.id), ["crt_a"]);
		assert.equal(store.readPage("crt_a", 1), null);
	});

	it("never builds a path from an id that is not a plain token", () => {
		for (const bad of ["../x", "a/b", "", "a b"]) {
			assert.throws(() => store.get(bad));
			assert.throws(() => store.workDir(bad));
		}
	});

	it("gives each job a working folder and removes everything with the job", () => {
		store.createJob(job("crt_a", "2026-11-04T08:00:00.000Z"));
		const work = store.workDir("crt_a");
		assert.ok(fs.statSync(work).isDirectory());
		assert.equal(path.dirname(work), path.join(dir, "crt_a"));
		store.writePage("crt_a", page(1));

		assert.equal(store.remove("crt_a"), true);
		assert.equal(fs.existsSync(path.join(dir, "crt_a")), false);
		assert.equal(store.remove("crt_a"), false);
	});
});

describe("create store: lesson jobs", () => {
	const lessonJob = (id: string): CreateJob => ({
		v: CREATE_SCHEMA,
		id,
		kind: "lesson",
		name: "Wrist nerves",
		nPages: 1,
		settings: DEFAULT_LESSON_SETTINGS,
		courseId: "anat",
		chatId: "c1",
		statements: [{ nodeId: "n_median", name: "Median nerve", statement: "The median nerve passes through the carpal tunnel." }],
		state: "queued",
		createdAt: "2026-11-05T08:00:00.000Z",
		pages: { "1": { status: "pending", count: 0, adopted: 0 } },
	});
	const result: LessonPageResult = {
		page: 1,
		nodeId: "n_median",
		cards: [{ id: "p001-c01", page: 1, type: "basic", front: "Q?", back: "A.", extra: "", deleted: false, include: true }],
		note: "",
	};

	it("keeps a lesson job and its statements' drafts, and reads them back", () => {
		store.createJob(lessonJob("crt_l"));
		assert.equal(store.get("crt_l")!.kind, "lesson");
		assert.equal(store.readLessonPage("crt_l", 1), null);
		store.writeLessonPage("crt_l", result);
		assert.deepEqual(store.readLessonPage("crt_l", 1), result);
		assert.equal(store.readLessonPage("crt_l", 2), null);
	});

	it("does not take a torn file, or a page of another kind, for a lesson page", () => {
		store.createJob(lessonJob("crt_l"));
		store.writePage("crt_l", page(1)); // an MC page has questions, not cards
		assert.equal(store.readLessonPage("crt_l", 1), null);
		store.writeLessonPage("crt_l", result);
		fs.writeFileSync(path.join(dir, "crt_l", "results", "p001.json"), "{ torn");
		assert.equal(store.readLessonPage("crt_l", 1), null);
	});
});
