/**
 * Bringing MedAnki's MC-test jobs over (src/server/create-legacy.ts) from a
 * throw-away folder shaped like <MedAnki>/data — never the real one.
 */

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { CreateInputError, type LectureSource } from "../src/core/contracts.ts";
import { mcqCardFields } from "../src/core/create.ts";
import type { LibraryStore } from "../src/core/ports.ts";
import type { CreateDeps } from "../src/server/create.ts";
import { importMedAnkiMcq, legacyMcqTag, scanMedAnkiMcq } from "../src/server/create-legacy.ts";
import { createCreateStore } from "../src/store/create.ts";
import { createStudyStore } from "../src/store/study.ts";
import { textPdf } from "./fixtures/text-pdf.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-legacy-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const NOW = new Date(2026, 10, 4, 10, 0, 0);
const JOB_A = "20261024-120523-28a4";
const JOB_B = "20261024-121203-4bd5";

const question = (page: number, i: number, over: object = {}) => ({
	id: `p${String(page).padStart(3, "0")}-q${String(i).padStart(2, "0")}`,
	page,
	question: `Which statements describe item ${page}.${i}?`,
	options: { A: `a${page}${i}`, B: `b${page}${i}`, C: `c${page}${i}`, D: `d${page}${i}` },
	correct: ["A", "C"],
	explanation: "A x.\nB x.\nC x.\nD x.",
	include: true,
	deleted: false,
	...over,
});

function writeJob(dataDir: string, id: string, opts: { lecture?: boolean; pages: Record<string, object>; results: Record<number, object[]> }) {
	const dir = path.join(dataDir, "mcq_jobs", id);
	fs.mkdirSync(path.join(dir, "questions"), { recursive: true });
	fs.writeFileSync(path.join(dir, "source.pdf"), textPdf([`Source of ${id}`], id));
	fs.writeFileSync(
		path.join(dir, "meta.json"),
		JSON.stringify({
			id,
			name: `Job ${id}`,
			filename: `Job ${id}.pdf`,
			created: "2026-10-24T12:05:23",
			n_pages: 2,
			settings: { model: "sonnet", language: "en", deck: "x", page_from: 1, page_to: 2, n_questions: 4, concurrency: 2 },
			state: "done",
			has_lecture: opts.lecture === true,
			lecture_filename: opts.lecture ? "Lecture slides.pdf" : null,
			pages: opts.pages,
		}),
	);
	for (const [page, questions] of Object.entries(opts.results)) {
		fs.writeFileSync(path.join(dir, "questions", `p${String(page).padStart(3, "0")}.json`), JSON.stringify({ page: Number(page), questions, status: "done" }));
	}
	if (opts.lecture) {
		fs.writeFileSync(path.join(dir, "lecture.pdf"), textPdf(["Lecture slides"], "lecture"));
		fs.writeFileSync(path.join(dir, "lecture_text.txt"), "LECTURE FACTS");
	}
}

function medAnkiFolder(): string {
	const dataDir = fs.mkdtempSync(path.join(root, "medanki-"));
	writeJob(dataDir, JOB_A, {
		pages: { "1": { status: "done", error: null, n_questions: 2 }, "2": { status: "done", error: null, n_questions: 1 } },
		results: { 1: [question(1, 1), question(1, 2, { include: false })], 2: [question(2, 1)] },
	});
	writeJob(dataDir, JOB_B, {
		lecture: true,
		pages: { "1": { status: "done", error: null, n_questions: 1 }, "2": { status: "error", error: "boom", n_questions: 0 } },
		results: { 1: [question(1, 1, { deleted: true })] },
	});
	// not jobs: a folder without a source PDF, and one whose name is no plain id
	fs.mkdirSync(path.join(dataDir, "mcq_jobs", "no-source"), { recursive: true });
	fs.writeFileSync(path.join(dataDir, "mcq_jobs", "no-source", "meta.json"), "{}");
	fs.mkdirSync(path.join(dataDir, "mcq_jobs", "bad name"), { recursive: true });
	return dataDir;
}

function setup() {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const sources = new Map<string, { source: LectureSource; file: string }>();
	const library: LibraryStore = {
		add: () => {
			throw new Error("not used");
		},
		get: (id) => sources.get(id)?.source ?? null,
		list: () => [...sources.values()].map((e) => e.source),
		update: () => null,
		pdfPath: (id) => sources.get(id)?.file ?? null,
		remove: () => false,
	};
	const study = createStudyStore({
		courses: path.join(dir, "courses.jsonl"),
		cards: path.join(dir, "cards.jsonl"),
		reviews: path.join(dir, "reviews.jsonl"),
	});
	study.upsertCourse({ id: "first-year", name: "1st Year", bufferDays: 5, createdAt: NOW.toISOString() });
	const deps: CreateDeps = {
		create: createCreateStore(path.join(dir, "create")),
		library,
		study,
		ask: async () => {
			throw new Error("not used");
		},
		renderPage: async () => new Uint8Array(),
		pageLines: async () => [],
		documentText: async () => "",
		// the real library dedupes by content hash; so does this one
		addPdf: async (fileName, data) => {
			const sha256 = crypto.createHash("sha256").update(data).digest("hex");
			const existing = [...sources.values()].find((e) => e.source.sha256 === sha256);
			if (existing) return existing.source;
			const id = `lec_${sources.size + 1}`;
			const source: LectureSource = { v: 1, id, title: fileName.replace(/\.pdf$/, ""), fileName, bytes: data.length, sha256, pages: 2, addedAt: NOW.toISOString(), status: "stored" };
			sources.set(id, { source, file: path.join(dir, `${id}.pdf`) });
			return source;
		},
		now: () => NOW,
		retryDelayMs: 0,
	};
	return { deps, study, sources };
}

/** A study card as the Anki import leaves an MC note. */
function ankiMcq(id: string, tags: string[], q: ReturnType<typeof question>) {
	return {
		id,
		courseId: "first-year",
		kind: "mcq" as const,
		fields: mcqCardFields({ question: q.question, options: q.options as never, correct: ["A", "C"], explanation: "x" }, "src"),
		tags,
		core: false,
		origin: { kind: "anki-import" as const, noteId: 1 },
		createdAt: NOW.toISOString(),
	};
}

describe("legacyMcqTag", () => {
	it("is MedAnki's tag for a question", () => {
		assert.equal(legacyMcqTag(JOB_A, "p001-q01"), `MedAnkiMcqID_${JOB_A}_p001-q01`);
	});
});

describe("the dry run", () => {
	it("lists the jobs and what would be linked, and writes nothing", () => {
		const { deps, study, sources } = setup();
		study.upsertCards([ankiMcq("anki_1", [legacyMcqTag(JOB_A, "p001-q01")], question(9, 9)), ankiMcq("anki_2", ["other"], question(2, 1))]);
		const scan = scanMedAnkiMcq(medAnkiFolder(), deps);

		assert.deepEqual(
			scan.jobs.map((j) => ({ id: j.id, pages: j.pages, questions: j.questions, alreadyImported: j.alreadyImported, linkable: j.linkable })),
			[
				{ id: JOB_A, pages: 2, questions: 3, alreadyImported: false, linkable: 2 },
				{ id: JOB_B, pages: 1, questions: 1, alreadyImported: false, linkable: 0 },
			],
		);
		assert.deepEqual(deps.create.list(), []);
		assert.equal(sources.size, 0);
	});

	it("finds nothing in a folder without MC jobs, and refuses a relative path", () => {
		const { deps } = setup();
		assert.deepEqual(scanMedAnkiMcq(fs.mkdtempSync(path.join(root, "empty-")), deps).jobs, []);
		assert.throws(() => scanMedAnkiMcq("MedAnki/data", deps), (e) => e instanceof CreateInputError && e.status === 400);
	});
});

describe("the import", () => {
	it("turns each MedAnki job into a finished Create job with its questions as drafts", async () => {
		const { deps, sources } = setup();
		const result = await importMedAnkiMcq(medAnkiFolder(), deps);
		assert.deepEqual(result, { imported: 2, alreadyThere: 0, questions: 4, linked: 0 });

		const a = deps.create.get(`crt_legacy_${JOB_A}`)!;
		assert.equal(a.name, `Job ${JOB_A}`);
		assert.equal(a.kind, "mcq");
		assert.equal(a.state, "done");
		assert.equal(a.nPages, 2);
		assert.equal(a.createdAt, new Date("2026-10-24T12:05:23").toISOString());
		assert.deepEqual(a.settings, { model: "sonnet", language: "en", questionsPerPage: 4, pageFrom: 1, pageTo: 2, concurrency: 2 });
		assert.equal(sources.get(a.lectureId)?.source.fileName, `Job ${JOB_A}.pdf`);
		assert.equal(a.sourceLectureId, undefined);
		// MedAnki's include=false is a deleted draft
		assert.deepEqual(a.pages, { "1": { status: "done", count: 1, adopted: 0 }, "2": { status: "done", count: 1, adopted: 0 } });
		const drafts = deps.create.readPage(a.id, 1)!.questions;
		assert.deepEqual(drafts.map((q) => [q.id, q.deleted]), [["p001-q01", false], ["p001-q02", true]]);
		assert.deepEqual(drafts[0]!.correct, ["A", "C"]);

		// the second job: a source PDF, its text for "more questions", a failed page, a deleted draft
		const b = deps.create.get(`crt_legacy_${JOB_B}`)!;
		assert.ok(b.kind === "mcq");
		assert.equal(sources.get(b.sourceLectureId!)?.source.fileName, "Lecture slides.pdf");
		assert.equal(fs.readFileSync(path.join(deps.create.workDir(b.id), "lecture.txt"), "utf-8"), "LECTURE FACTS");
		assert.equal(b.pages["2"]?.status, "error");
		assert.equal(b.pages["2"]?.error, "boom");
		assert.equal(b.pages["1"]?.count, 0);
		assert.equal(sources.size, 3);
	});

	it("marks questions that already exist as study cards as adopted — by MedAnki's tag, then by identical text", async () => {
		const { deps, study } = setup();
		study.upsertCards([
			// same tag, different text: the tag wins
			ankiMcq("anki_1", [legacyMcqTag(JOB_A, "p001-q01")], question(9, 9)),
			// no tag, identical question and options
			ankiMcq("anki_2", ["unrelated"], question(2, 1)),
			// similar but not the same
			ankiMcq("anki_3", [], question(1, 2, { question: "A different question?" })),
		]);
		const result = await importMedAnkiMcq(medAnkiFolder(), deps);
		assert.equal(result.linked, 2);

		const a = deps.create.get(`crt_legacy_${JOB_A}`)!;
		assert.deepEqual(a.pages["1"], { status: "done", count: 1, adopted: 1 });
		assert.deepEqual(deps.create.readPage(a.id, 1)!.questions[0]!.adopted, { courseId: "first-year", cardId: "anki_1", at: NOW.toISOString() });
		assert.equal(deps.create.readPage(a.id, 2)!.questions[0]!.adopted?.cardId, "anki_2");
		assert.equal(study.readCards().length, 3, "no card was added");
	});

	it("is idempotent: a second import changes nothing and stores no PDF twice", async () => {
		const { deps, sources } = setup();
		const dataDir = medAnkiFolder();
		await importMedAnkiMcq(dataDir, deps);
		const before = JSON.stringify(deps.create.list());
		const again = await importMedAnkiMcq(dataDir, deps);
		assert.deepEqual(again, { imported: 0, alreadyThere: 2, questions: 0, linked: 0 });
		assert.equal(JSON.stringify(deps.create.list()), before);
		assert.equal(sources.size, 3);
		assert.ok(scanMedAnkiMcq(dataDir, deps).jobs.every((j) => j.alreadyImported));
	});

	it("never changes MedAnki's folder", async () => {
		const { deps } = setup();
		const dataDir = medAnkiFolder();
		const listing = () =>
			fs
				.readdirSync(dataDir, { recursive: true, withFileTypes: true })
				.map((e) => `${e.parentPath}/${e.name}:${e.isFile() ? fs.statSync(path.join(e.parentPath, e.name)).size : "d"}`)
				.sort();
		const before = listing();
		await importMedAnkiMcq(dataDir, deps);
		assert.deepEqual(listing(), before);
	});
});
