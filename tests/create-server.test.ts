/**
 * The Create service (src/server/create.ts) end to end with a SCRIPTED model:
 * a throw-away create store, study store and library — never data/*, never the
 * real Claude CLI or a real PDF engine.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { ClaudeAskError, type AskClaude, type AskClaudeRequest } from "../src/agent/claude-ask.ts";
import { CreateInputError, type LectureSource } from "../src/core/contracts.ts";
import { mcqCorrect } from "../src/core/study-render.ts";
import type { LibraryStore } from "../src/core/ports.ts";
import {
	adoptQuestions,
	createMcqJob,
	deleteCreateJob,
	getCreateJob,
	listCreateJobs,
	setQuestionDeleted,
	startCreateJob,
	stopCreateJob,
	type CreateDeps,
} from "../src/server/create.ts";
import { createCreateStore } from "../src/store/create.ts";
import { createStudyStore } from "../src/store/study.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-server-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const NOW = new Date(2026, 10, 4, 10, 0, 0);

/** Valid model answer for a page: `n` questions, text unique per page and index. */
function answer(page: number, n = 2): string {
	return JSON.stringify({
		questions: Array.from({ length: n }, (_, i) => ({
			question: `Which statements describe topic ${page}.${i + 1}?`,
			options: { A: `A${page}`, B: `B${page}`, C: `C${page}`, D: `D${page}` },
			correct: i % 2 === 0 ? ["B", "C"] : ["A"],
			explanation: "A x.\nB x.\nC x.\nD x.",
		})),
	});
}

const pageOf = (req: AskClaudeRequest): number => Number(/Seite (\d+) von/.exec(req.prompt)?.[1]);
const scripted: AskClaude = async (req) => ({ text: answer(pageOf(req)), costUsd: 0, durationMs: 1 });

function fakeLibrary(dir: string, entries: Record<string, { title: string; pages: number }>): LibraryStore {
	const sources = (): LectureSource[] =>
		Object.entries(entries).map(([id, e]) => ({
			v: 1,
			id,
			title: e.title,
			fileName: `${e.title}.pdf`,
			bytes: 10,
			sha256: id,
			pages: e.pages,
			addedAt: NOW.toISOString(),
			status: "stored",
		}));
	return {
		add: () => {
			throw new Error("not used");
		},
		get: (id) => sources().find((s) => s.id === id) ?? null,
		list: sources,
		update: () => null,
		pdfPath: (id) => (entries[id] ? path.join(dir, `${id}.pdf`) : null),
		remove: () => false,
	};
}

function setup(over: Partial<CreateDeps> = {}, pages = 3) {
	const { ask = scripted, ...rest } = over;
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const create = createCreateStore(path.join(dir, "create"));
	const study = createStudyStore({
		courses: path.join(dir, "courses.jsonl"),
		cards: path.join(dir, "cards.jsonl"),
		reviews: path.join(dir, "reviews.jsonl"),
	});
	study.upsertCourse({ id: "anatomy", name: "Anatomy", bufferDays: 5, createdAt: NOW.toISOString() });
	const asked: AskClaudeRequest[] = [];
	const rendered: number[] = [];
	const deps: CreateDeps = {
		create,
		library: fakeLibrary(dir, { lec1: { title: "Upper limb", pages }, lec2: { title: "Slides", pages: 5 } }),
		study,
		ask: async (req) => {
			asked.push(req);
			return ask(req);
		},
		renderPage: async (_pdf, page) => {
			rendered.push(page);
			return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		},
		pageLines: async (_pdf, page) => [{ id: "T001", text: `Text of page ${page}` }],
		documentText: async () => "LECTURE TEXT",
		addPdf: async () => {
			throw new Error("not used");
		},
		now: () => NOW,
		retryDelayMs: 0,
		...rest,
	};
	return { deps, create, study, asked, rendered };
}

/** Create a job and let its run finish. */
async function runJob(deps: CreateDeps, settings: object = {}, extra: object = {}) {
	const summary = await createMcqJob({ lectureId: "lec1", settings, autostart: false, ...extra }, deps);
	await startCreateJob(summary.id, {}, deps).settled;
	return summary.id;
}

describe("creating a job", () => {
	it("names the job after the PDF and plans one pending page per page of the range", async () => {
		const { deps } = setup();
		const job = await createMcqJob({ lectureId: "lec1", settings: { pageFrom: 2, pageTo: 99 }, autostart: false }, deps);
		assert.equal(job.name, "Upper limb");
		assert.equal(job.state, "queued");
		assert.equal(job.nPages, 3);
		assert.equal(job.total, 2);
		assert.deepEqual(job.counts, { pending: 2, running: 0, done: 0, error: 0 });
		assert.deepEqual(
			getCreateJob(job.id, deps).pages.map((p) => p.page),
			[2, 3],
		);
		assert.deepEqual(getCreateJob(job.id, deps).settings.pageTo, 3);
	});

	it("refuses an unknown PDF, an unknown source PDF and a backwards page range", async () => {
		const { deps } = setup();
		await assert.rejects(createMcqJob({ lectureId: "nope" }, deps), (e) => e instanceof CreateInputError && e.status === 404);
		await assert.rejects(createMcqJob({ lectureId: "lec1", sourceLectureId: "nope" }, deps), (e) => e instanceof CreateInputError && e.status === 404);
		await assert.rejects(createMcqJob({ lectureId: "lec1", settings: { pageFrom: 3, pageTo: 2 } }, deps), (e) => e instanceof CreateInputError && e.status === 400);
		assert.equal(listCreateJobs(deps).length, 0);
	});

	it("starts the run by itself unless told not to", async () => {
		const { deps, asked } = setup();
		const job = await createMcqJob({ lectureId: "lec1" }, deps);
		await startCreateJob(job.id, {}, deps).settled; // a run in flight: started false, settled at once
		for (let i = 0; i < 100 && getCreateJob(job.id, deps).job.state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(getCreateJob(job.id, deps).job.state, "done");
		assert.equal(asked.length, 3);
	});
});

describe("a run", () => {
	it("asks once per page and keeps only valid questions as numbered drafts", async () => {
		const bad = JSON.stringify({ questions: [{ question: "no options" }, ...JSON.parse(answer(1, 2)).questions] });
		const { deps, asked } = setup({ ask: async () => ({ text: "```json\n" + bad + "\n```", costUsd: 0, durationMs: 1 }) });
		const id = await runJob(deps);

		assert.equal(asked.length, 3);
		const detail = getCreateJob(id, deps);
		assert.equal(detail.job.state, "done");
		assert.deepEqual(detail.job.counts, { pending: 0, running: 0, done: 3, error: 0 });
		assert.equal(detail.job.drafts, 6);
		assert.deepEqual(
			detail.pages[0]!.questions.map((q) => q.id),
			["p001-q01", "p001-q02"],
		);
		assert.deepEqual(detail.pages[1]!.questions.map((q) => q.page), [2, 2]);
		assert.equal(detail.pages[0]!.questions[0]!.deleted, false);
	});

	it("gives the model the page image, the page text, the language and the question count", async () => {
		const { deps, asked, rendered } = setup();
		await runJob(deps, { questionsPerPage: 6, language: "de" });

		const first = asked.find((r) => pageOf(r) === 1)!;
		assert.match(first.prompt, /Dokument: Upper limb — Seite 1 von 3/);
		assert.match(first.prompt, /Seitenbild: pages[\\/]p001\.png/);
		assert.match(first.prompt, /\[T001\] Text of page 1/);
		assert.doesNotMatch(first.prompt, /Zusatzmaterial/);
		assert.match(first.system, /Erstelle sonst 6 Fragen/);
		assert.match(first.system, /Schreibe ALLE Karten auf Deutsch/);
		assert.equal(first.model, "sonnet");
		assert.ok(fs.existsSync(path.join(first.cwd, "pages", "p001.png")), "the image is in the folder the model reads from");
		assert.deepEqual(rendered.sort(), [1, 2, 3]);
	});

	it("puts the second PDF's text into every page prompt", async () => {
		const { deps, asked } = setup();
		await runJob(deps, {}, { sourceLectureId: "lec2" });
		assert.equal(asked.length, 3);
		for (const req of asked) {
			assert.match(req.prompt, /Zusatzmaterial: Vorlesungsfolien/);
			assert.match(req.prompt, /LECTURE TEXT/);
		}
	});

	it("runs without the extra material when the second PDF has no readable text", async () => {
		const { deps, asked } = setup({
			documentText: async () => {
				throw new Error("scanned");
			},
		});
		const id = await runJob(deps, {}, { sourceLectureId: "lec2" });
		assert.equal(getCreateJob(id, deps).job.state, "done");
		assert.doesNotMatch(asked[0]!.prompt, /Zusatzmaterial/);
	});

	it("retries a call that failed once", async () => {
		let calls = 0;
		const { deps } = setup({
			ask: async (req) => {
				if (++calls === 1) throw new ClaudeAskError("flaky", "other");
				return scripted(req);
			},
		}, 1);
		const id = await runJob(deps);
		assert.equal(getCreateJob(id, deps).pages[0]!.status, "done");
		assert.equal(calls, 2);
	});

	it("retries an answer that was not JSON, telling the model what was wrong", async () => {
		let calls = 0;
		const { deps, asked } = setup({
			ask: async (req) => (++calls === 1 ? { text: "sorry, no JSON", costUsd: 0, durationMs: 1 } : scripted(req)),
		}, 1);
		const id = await runJob(deps);
		assert.equal(getCreateJob(id, deps).pages[0]!.status, "done");
		assert.equal(asked.length, 2);
		assert.doesNotMatch(asked[0]!.prompt, /nicht als gültiges JSON verwertbar/);
		assert.match(asked[1]!.prompt, /nicht als gültiges JSON verwertbar \(JSON error/);
	});

	it("marks a page that fails twice as an error and leaves the others alone; a retry of that page fixes it", async () => {
		let broken = true;
		const { deps } = setup({
			ask: async (req) => (pageOf(req) === 2 && broken ? { text: "no json", costUsd: 0, durationMs: 1 } : scripted(req)),
		});
		const id = await runJob(deps);
		let detail = getCreateJob(id, deps);
		assert.equal(detail.job.state, "done");
		assert.deepEqual(detail.job.counts, { pending: 0, running: 0, done: 2, error: 1 });
		assert.match(detail.pages[1]!.error ?? "", /JSON error/);

		broken = false;
		await startCreateJob(id, { pages: [2] }, deps).settled;
		detail = getCreateJob(id, deps);
		assert.equal(detail.pages[1]!.status, "done");
		assert.equal(detail.pages[1]!.questions.length, 2);
		assert.equal(detail.job.drafts, 6);
	});

	it("resumes only the unfinished pages", async () => {
		const { deps, asked } = setup();
		const id = await runJob(deps);
		asked.length = 0;
		assert.equal(startCreateJob(id, {}, deps).started, false); // nothing left to do
		deps.create.update(id, (j) => {
			j.pages["3"]!.status = "pending";
		});
		await startCreateJob(id, {}, deps).settled;
		assert.deepEqual(asked.map(pageOf), [3]);
	});

	it("asks for different questions on 'more', keeping every earlier draft and numbering on", async () => {
		const { deps, asked } = setup({}, 1);
		const id = await runJob(deps);
		asked.length = 0;
		await startCreateJob(id, { more: true }, deps).settled;

		assert.equal(asked.length, 1);
		assert.match(asked[0]!.prompt, /Bereits vorhandene Fragen zu dieser Seite \(NICHT wiederholen\)/);
		assert.match(asked[0]!.prompt, /1\. Which statements describe topic 1\.1\?/);
		const questions = getCreateJob(id, deps).pages[0]!.questions;
		assert.deepEqual(
			questions.map((q) => q.id),
			["p001-q01", "p001-q02", "p001-q03", "p001-q04"],
		);
	});

	it("re-running a page replaces its drafts but keeps an adopted one", async () => {
		const { deps } = setup({}, 1);
		const id = await runJob(deps);
		adoptQuestions(id, { courseId: "anatomy", questionIds: ["p001-q01"] }, deps);
		await startCreateJob(id, { pages: [1] }, deps).settled;

		const questions = getCreateJob(id, deps).pages[0]!.questions;
		assert.deepEqual(
			questions.map((q) => q.id),
			["p001-q01", "p001-q02", "p001-q03"],
		);
		assert.ok(questions[0]!.adopted);
		assert.equal(questions[1]!.adopted, undefined);
	});
});

describe("stopping", () => {
	it("stop puts the pages in flight back to pending — not error — and the job to stopped", async () => {
		let started!: () => void;
		const inFlight = new Promise<void>((resolve) => (started = resolve));
		const { deps } = setup({
			ask: (req) =>
				new Promise((_, reject) => {
					started();
					req.signal?.addEventListener("abort", () => reject(new ClaudeAskError("cancelled", "aborted")));
				}),
		});
		const summary = await createMcqJob({ lectureId: "lec1", settings: { concurrency: 1 }, autostart: false }, deps);
		const { settled } = startCreateJob(summary.id, {}, deps);
		await inFlight;
		assert.equal(getCreateJob(summary.id, deps).job.running, true);
		assert.equal(stopCreateJob(summary.id), true);
		await settled;

		const detail = getCreateJob(summary.id, deps);
		assert.equal(detail.job.state, "stopped");
		assert.equal(detail.job.running, false);
		assert.deepEqual(detail.job.counts, { pending: 3, running: 0, done: 0, error: 0 });
		assert.equal(stopCreateJob(summary.id), false);
	});

	it("a lost sign-in stops the whole run at once and says why; nothing is marked as failed", async () => {
		const { deps, asked } = setup({
			ask: async () => {
				throw new ClaudeAskError("The Claude CLI is not signed in. Open Terminal, run `claude`.", "auth");
			},
		});
		const id = await runJob(deps, { concurrency: 1 });

		const detail = getCreateJob(id, deps);
		assert.equal(asked.length, 1, "no further page is tried");
		assert.equal(detail.job.state, "stopped");
		assert.match(detail.job.blocked ?? "", /not signed in/);
		assert.deepEqual(detail.job.counts, { pending: 3, running: 0, done: 0, error: 0 });

		// signed in again: the run picks up where it stopped and clears the notice
		await startCreateJob(id, {}, { ...deps, ask: scripted }).settled;
		const after = getCreateJob(id, deps);
		assert.equal(after.job.state, "done");
		assert.equal(after.job.blocked, undefined);
	});

	it("reports a run that a restart cut off as interrupted, with its pages resumable", async () => {
		const { deps, create } = setup();
		const summary = await createMcqJob({ lectureId: "lec1", autostart: false }, deps);
		create.update(summary.id, (j) => {
			j.state = "running";
			j.pages["1"]!.status = "running";
		});
		const [listed] = listCreateJobs(deps);
		assert.equal(listed!.state, "interrupted");
		assert.equal(listed!.running, false);
		assert.equal(getCreateJob(summary.id, deps).pages[0]!.status, "pending");
	});

	it("start refuses pages that are not in the job", async () => {
		const { deps } = setup();
		const summary = await createMcqJob({ lectureId: "lec1", autostart: false }, deps);
		assert.throws(() => startCreateJob(summary.id, { pages: [77] }, deps), (e) => e instanceof CreateInputError && e.status === 400);
		assert.throws(() => startCreateJob("crt_unknown", {}, deps), (e) => e instanceof CreateInputError && e.status === 404);
	});
});

describe("deleting", () => {
	it("removes a finished job with its drafts, and refuses a running one", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const { deps, create } = setup({ ask: async (req) => (await gate, scripted(req)) });
		const summary = await createMcqJob({ lectureId: "lec1", settings: { concurrency: 1 }, autostart: false }, deps);
		const { settled } = startCreateJob(summary.id, {}, deps);
		assert.throws(() => deleteCreateJob(summary.id, deps), (e) => e instanceof CreateInputError && e.status === 409);
		release();
		await settled;

		deleteCreateJob(summary.id, deps);
		assert.equal(create.get(summary.id), null);
		assert.deepEqual(listCreateJobs(deps), []);
		assert.throws(() => deleteCreateJob(summary.id, deps), (e) => e instanceof CreateInputError && e.status === 404);
	});
});

describe("drafts", () => {
	it("deletes and restores a draft softly and keeps the counters right", async () => {
		const { deps } = setup({}, 1);
		const id = await runJob(deps);
		assert.equal(getCreateJob(id, deps).job.drafts, 2);

		assert.equal(setQuestionDeleted(id, "p001-q01", true, deps).deleted, true);
		assert.equal(getCreateJob(id, deps).job.drafts, 1);
		assert.equal(getCreateJob(id, deps).pages[0]!.questions.length, 2, "still stored");
		assert.equal(setQuestionDeleted(id, "p001-q01", false, deps).deleted, false);
		assert.equal(getCreateJob(id, deps).job.drafts, 2);

		assert.throws(() => setQuestionDeleted(id, "p001-q09", true, deps), (e) => e instanceof CreateInputError && e.status === 404);
		assert.throws(() => setQuestionDeleted(id, "../x", true, deps), (e) => e instanceof CreateInputError && e.status === 404);
	});
});

describe("adopting drafts into a course", () => {
	it("makes study cards the review screen can show, once", async () => {
		const { deps, study } = setup({}, 1);
		const id = await runJob(deps);
		setQuestionDeleted(id, "p001-q02", true, deps);

		const result = adoptQuestions(id, { courseId: "anatomy" }, deps);
		assert.deepEqual(result, { adopted: 1, skipped: 1 });

		const [card] = study.readCards();
		assert.ok(card);
		assert.equal(study.readCards().length, 1);
		assert.equal(card.id, `crt_${id}_p001-q01`);
		assert.equal(card.courseId, "anatomy");
		assert.equal(card.kind, "mcq");
		assert.equal(card.core, false);
		assert.deepEqual(card.origin, { kind: "pdf", jobId: id, page: 1 });
		assert.equal(card.topic, "Upper limb");
		assert.equal(card.fields.Question, "Which statements describe topic 1.1?");
		assert.equal(card.fields.OptionB, "B1");
		assert.deepEqual(mcqCorrect(card.fields), ["B", "C"]);
		assert.equal(card.fields.Source, "Upper limb · p. 1");

		const draft = getCreateJob(id, deps).pages[0]!.questions[0]!;
		assert.deepEqual(draft.adopted, { courseId: "anatomy", cardId: card.id, at: NOW.toISOString() });
		assert.equal(getCreateJob(id, deps).job.adopted, 1);

		// adopting again changes nothing — the same draft never becomes a second card
		assert.deepEqual(adoptQuestions(id, { courseId: "anatomy" }, deps), { adopted: 0, skipped: 2 });
		assert.equal(study.readCards().length, 1);
	});

	it("takes just the drafts asked for", async () => {
		const { deps, study } = setup({}, 2);
		const id = await runJob(deps);
		assert.deepEqual(adoptQuestions(id, { courseId: "anatomy", questionIds: ["p002-q02", "p001-q01"] }, deps), { adopted: 2, skipped: 0 });
		assert.deepEqual(
			study.readCards().map((c) => c.id).sort(),
			[`crt_${id}_p001-q01`, `crt_${id}_p002-q02`],
		);
	});

	it("refuses an unknown course and an adopted draft's deletion", async () => {
		const { deps, study } = setup({}, 1);
		const id = await runJob(deps);
		assert.throws(() => adoptQuestions(id, { courseId: "nope" }, deps), (e) => e instanceof CreateInputError && e.status === 404);
		assert.equal(study.readCards().length, 0);

		adoptQuestions(id, { courseId: "anatomy" }, deps);
		assert.throws(() => setQuestionDeleted(id, "p001-q01", true, deps), (e) => e instanceof CreateInputError && e.status === 409);
	});
});
