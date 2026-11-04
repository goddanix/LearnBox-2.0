/**
 * The Create service (Learnbox 2.0, 2026-11): PDF → draft study material.
 *
 * A job walks the pages of one library PDF; for each page it renders the page
 * image, reads the page's text lines, and asks Claude (one `claude -p` call per
 * page, on the learner's own sign-in) for exam-style multiple-choice questions.
 * The answers are DRAFTS in the job's own folder (store/create.ts) — they reach
 * the study ledgers only when the learner adopts them into a course.
 *
 * Runs are background work with one in-memory handle per job. The record
 * carries the progress (page statuses), so the UI polls the list. A job that
 * says "running" with no live handle was cut off by a restart; reading it
 * reports "interrupted" and makes its unfinished pages resumable. A lost
 * sign-in, a reached plan limit or a missing CLI stops the whole run (every
 * further page would fail the same way) and says so in `blocked`.
 *
 * Every function takes its collaborators as a last `deps` argument (the live
 * stores, the real Claude CLI and PDF engine by default), so tests run the
 * whole flow with a scripted model in a temp dir.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ClaudeAskError, askClaude, type AskClaude } from "../agent/claude-ask.ts";
import { mcqPagePrompt, mcqSystemPrompt, repairSuffix } from "../agent/create/mcq-prompts.ts";
import { getHeadless } from "../agent/subagents/headless.ts";
import { pdfExtract, pdfPageCount, pdfPageLines, type PdfTextLine } from "../agent/subagents/pdf-ops.ts";
import {
	CREATE_SCHEMA,
	CreateInputError,
	type CreateJob,
	type CreateJobDetail,
	type CreateJobPageView,
	type CreateJobSummary,
	type LectureSource,
	type McqPageResult,
	type McqQuestion,
	type StudyCard,
} from "../core/contracts.ts";
import {
	cleanMcqSettings,
	clampPageRange,
	countPages,
	mcqCardFields,
	pageNumbers,
	pageOfQuestionId,
	parseModelJson,
	questionId,
	validateMcqQuestion,
} from "../core/create.ts";
import type { CreateStore, LibraryStore, StudyStore } from "../core/ports.ts";
import { addLecture } from "./library.ts";
import { stores } from "./stores.ts";

export interface CreateDeps {
	create: CreateStore;
	library: LibraryStore;
	study: StudyStore;
	ask: AskClaude;
	/** One page as PNG bytes. */
	renderPage: (pdfPath: string, page: number) => Promise<Uint8Array>;
	pageLines: (pdfPath: string, page: number) => Promise<PdfTextLine[]>;
	/** The whole text of a PDF, cut to `maxChars`. */
	documentText: (pdfPath: string, maxChars: number) => Promise<string>;
	/** Put a PDF into the library (the same PDF twice is stored once). */
	addPdf: (fileName: string, data: Uint8Array) => Promise<LectureSource>;
	now: () => Date;
	/** Pause before the second try of a failed call. */
	retryDelayMs: number;
}

export const defaultCreateDeps = (): CreateDeps => ({
	create: stores.createStore,
	library: stores.libraryStore,
	study: stores.studyStore,
	ask: askClaude,
	renderPage: async (pdfPath, page) => {
		const [rendered] = await getHeadless().renderPdfPages(pdfPath, [page], { dpi: 150 });
		if (!rendered) throw new Error(`page ${page} could not be rendered`);
		return rendered.png;
	},
	pageLines: pdfPageLines,
	documentText: async (pdfPath, maxChars) => {
		const text = (await pdfExtract(pdfPath, "all")).trim();
		return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (cut)` : text;
	},
	addPdf: async (fileName, data) => (await addLecture(fileName, data)).source,
	now: () => new Date(),
	retryDelayMs: 3000,
});

/** Upper bound for the second PDF's text: it rides in EVERY page prompt, so it is kept short. */
const LECTURE_MAX_CHARS = 40_000;
export const LECTURE_TEXT_FILE = "lecture.txt";

/** Jobs with a live run, by id (the abort handle). Kept on globalThis: Next may load this module once per
 *  route bundle, and the start route and the list route must see the same runs. */
const runs = globalThis as typeof globalThis & { __lbCreateRuns?: Map<string, AbortController> };
const running = (runs.__lbCreateRuns ??= new Map<string, AbortController>());

const pad = (page: number) => String(page).padStart(3, "0");
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ─── reading jobs ────────────────────────────────────────────────────────────

/** A job record as stored, but with a run that no longer exists reported honestly:
 *  "interrupted", its unfinished pages back to "pending". */
function reconciled(job: CreateJob, deps: CreateDeps): CreateJob {
	if (job.state !== "running" || running.has(job.id)) return job;
	return (
		deps.create.update(job.id, (j) => {
			j.state = "interrupted";
			for (const page of Object.values(j.pages)) if (page.status === "running") page.status = "pending";
		}) ?? job
	);
}

function summarize(job: CreateJob): CreateJobSummary {
	const pages = Object.values(job.pages);
	return {
		id: job.id,
		kind: job.kind,
		name: job.name,
		lectureId: job.lectureId,
		state: job.state,
		running: running.has(job.id),
		...(job.blocked ? { blocked: job.blocked } : {}),
		...(job.fatal ? { fatal: job.fatal } : {}),
		createdAt: job.createdAt,
		nPages: job.nPages,
		total: pages.length,
		counts: countPages(job.pages),
		drafts: pages.reduce((sum, p) => sum + p.count, 0),
		adopted: pages.reduce((sum, p) => sum + p.adopted, 0),
	};
}

export function listCreateJobs(deps: CreateDeps = defaultCreateDeps()): CreateJobSummary[] {
	return deps.create.list().map((job) => summarize(reconciled(job, deps)));
}

function requireJob(id: string, deps: CreateDeps): CreateJob {
	const job = /^[A-Za-z0-9_-]+$/.test(id) ? deps.create.get(id) : null;
	if (!job) throw new CreateInputError("Unknown job", 404);
	return reconciled(job, deps);
}

export function getCreateJob(id: string, deps: CreateDeps = defaultCreateDeps()): CreateJobDetail {
	const job = requireJob(id, deps);
	const pages: CreateJobPageView[] = pageNumbers(job).map((page) => {
		const meta = job.pages[String(page)]!;
		return {
			page,
			status: meta.status,
			...(meta.error ? { error: meta.error } : {}),
			questions: deps.create.readPage(id, page)?.questions ?? [],
		};
	});
	return { job: summarize(job), settings: job.settings, pages };
}

// ─── creating a job ──────────────────────────────────────────────────────────

export interface CreateMcqJobInput {
	lectureId: string;
	/** A second library PDF whose text is the factual source of the questions. */
	sourceLectureId?: string;
	settings?: unknown;
	/** Start the run right away (default). */
	autostart?: boolean;
}

export async function createMcqJob(input: CreateMcqJobInput, deps: CreateDeps = defaultCreateDeps()): Promise<CreateJobSummary> {
	const lecture = deps.library.get(input.lectureId);
	const pdf = deps.library.pdfPath(input.lectureId);
	if (!lecture || !pdf) throw new CreateInputError("Unknown PDF — add it to the library first", 404);
	const nPages = lecture.pages ?? (await pdfPageCount(pdf));

	let sourcePdf: string | null = null;
	if (input.sourceLectureId) {
		sourcePdf = deps.library.pdfPath(input.sourceLectureId);
		if (!deps.library.get(input.sourceLectureId) || !sourcePdf) throw new CreateInputError("Unknown source PDF", 404);
	}

	const settings = cleanMcqSettings(input.settings);
	if (settings.pageTo > 0 && settings.pageFrom > settings.pageTo) {
		throw new CreateInputError("The page range is wrong: “from” is larger than “to”", 400);
	}
	const range = clampPageRange(settings.pageFrom, settings.pageTo, nPages);
	settings.pageFrom = range.from;
	settings.pageTo = range.to;

	const id = `crt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
	const job: CreateJob = {
		v: CREATE_SCHEMA,
		id,
		kind: "mcq",
		name: lecture.title,
		lectureId: lecture.id,
		...(input.sourceLectureId ? { sourceLectureId: input.sourceLectureId } : {}),
		nPages,
		settings,
		state: "queued",
		createdAt: deps.now().toISOString(),
		pages: Object.fromEntries(
			Array.from({ length: range.to - range.from + 1 }, (_, i) => [String(range.from + i), { status: "pending", count: 0, adopted: 0 }]),
		),
	};
	deps.create.createJob(job);

	if (sourcePdf) {
		// A scanned source without a text layer still lets the job run, just without the extra knowledge.
		const text = await deps.documentText(sourcePdf, LECTURE_MAX_CHARS).catch(() => "");
		fs.writeFileSync(path.join(deps.create.workDir(id), LECTURE_TEXT_FILE), text, "utf-8");
	}
	if (input.autostart !== false) startCreateJob(id, {}, deps);
	return summarize(deps.create.get(id) ?? job);
}

// ─── running a job ───────────────────────────────────────────────────────────

/** The whole run must stop: the sign-in is gone, the plan's limit is reached, or the CLI is missing. */
class RunBlocked extends Error {}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** Ask for a JSON object; one repair retry for an unreadable answer, one plain retry for a failed call. */
async function askJson(
	deps: CreateDeps,
	request: { prompt: string; system: string; cwd: string; model: string; signal: AbortSignal },
): Promise<Record<string, unknown>> {
	const retries = 1;
	let last = "unknown error";
	for (let attempt = 0; attempt <= retries; attempt++) {
		const prompt = attempt === 0 ? request.prompt : request.prompt + repairSuffix(last);
		let text: string;
		try {
			text = (await deps.ask({ ...request, prompt })).text;
		} catch (err) {
			if (!(err instanceof ClaudeAskError) || err.kind === "aborted") throw err;
			if (err.kind !== "other") throw new RunBlocked(err.message);
			last = err.message;
			if (attempt < retries) await sleep(deps.retryDelayMs);
			continue;
		}
		try {
			return parseModelJson(text);
		} catch (err) {
			last = `JSON error: ${errorText(err)}`;
		}
	}
	throw new Error(last);
}

function pageMeta(result: McqPageResult) {
	const live = result.questions.filter((q) => !q.deleted);
	return { count: live.length, adopted: live.filter((q) => q.adopted).length };
}

/** Write one page's drafts and keep the job's counters for that page in step. */
function savePage(jobId: string, result: McqPageResult, deps: CreateDeps): void {
	deps.create.writePage(jobId, result);
	deps.create.update(jobId, (j) => {
		const page = j.pages[String(result.page)];
		if (page) Object.assign(page, pageMeta(result));
	});
}

const nextQuestionIndex = (questions: readonly McqQuestion[]): number =>
	questions.reduce((max, q) => Math.max(max, Number(/-q(\d+)$/.exec(q.id)?.[1] ?? 0)), 0) + 1;

type RunMode = "resume" | "more";

async function processMcqPage(job: CreateJob, n: number, mode: RunMode, signal: AbortSignal, deps: CreateDeps): Promise<void> {
	const setPage = (change: (page: CreateJob["pages"][string]) => void) =>
		deps.create.update(job.id, (j) => {
			const page = j.pages[String(n)];
			if (page) change(page);
		});
	setPage((p) => {
		p.status = "running";
		delete p.error;
	});
	try {
		const pdf = deps.library.pdfPath(job.lectureId);
		if (!pdf) throw new Error("The PDF is no longer in the library.");
		const work = deps.create.workDir(job.id);
		const imageRel = path.join("pages", `p${pad(n)}.png`);
		const imageFile = path.join(work, imageRel);
		if (!fs.existsSync(imageFile)) {
			fs.mkdirSync(path.dirname(imageFile), { recursive: true });
			fs.writeFileSync(imageFile, await deps.renderPage(pdf, n));
		}
		const lines = await deps.pageLines(pdf, n);

		// "more" keeps every draft and asks for DIFFERENT questions; a plain (re)run of a page
		// replaces its drafts but never drops one the learner already adopted.
		const before = deps.create.readPage(job.id, n)?.questions ?? [];
		const kept = mode === "more" ? before : before.filter((q) => q.adopted);
		const lectureFile = path.join(work, LECTURE_TEXT_FILE);
		const lectureText = fs.existsSync(lectureFile) ? fs.readFileSync(lectureFile, "utf-8").trim() : "";

		const answer = await askJson(deps, {
			prompt: mcqPagePrompt({
				docName: job.name,
				pageNo: n,
				nPages: job.nPages,
				imageRel,
				lines,
				lectureText: lectureText || null,
				avoidQuestions: mode === "more" ? kept.filter((q) => !q.deleted).map((q) => q.question) : undefined,
			}),
			system: mcqSystemPrompt(job.settings.language, job.settings.questionsPerPage),
			cwd: work,
			model: job.settings.model,
			signal,
		});

		const fresh: McqQuestion[] = [];
		let index = nextQuestionIndex(kept);
		for (const raw of Array.isArray(answer.questions) ? answer.questions : []) {
			const draft = validateMcqQuestion(raw);
			if (!draft) continue;
			fresh.push({ id: questionId(n, index++), page: n, ...draft, deleted: false });
		}
		const result: McqPageResult = { page: n, questions: [...kept, ...fresh] };
		savePage(job.id, result, deps);
		setPage((p) => {
			p.status = "done";
		});
	} catch (err) {
		if (err instanceof RunBlocked) {
			setPage((p) => {
				p.status = "pending";
			});
			throw err;
		}
		if (signal.aborted || (err instanceof ClaudeAskError && err.kind === "aborted")) {
			setPage((p) => {
				p.status = "pending";
			});
			return;
		}
		setPage((p) => {
			p.status = "error";
			p.error = errorText(err).slice(0, 400);
		});
	}
}

async function runJob(jobId: string, pages: number[], mode: RunMode, controller: AbortController, deps: CreateDeps): Promise<void> {
	let blocked: string | undefined;
	let fatal: string | undefined;
	try {
		const job = deps.create.update(jobId, (j) => {
			j.state = "running";
			delete j.blocked;
			delete j.fatal;
			for (const n of pages) {
				const page = j.pages[String(n)];
				if (page) {
					page.status = "pending";
					delete page.error;
				}
			}
		});
		if (!job) return;
		const queue = [...pages];
		const worker = async () => {
			while (!controller.signal.aborted) {
				const n = queue.shift();
				if (n === undefined) return;
				const current = deps.create.get(jobId);
				if (!current) return; // deleted meanwhile
				try {
					await processMcqPage(current, n, mode, controller.signal, deps);
				} catch (err) {
					if (!(err instanceof RunBlocked)) throw err;
					blocked ??= err.message;
					controller.abort(); // every further page would fail the same way
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(job.settings.concurrency, pages.length) }, worker));
	} catch (err) {
		fatal = errorText(err).slice(0, 400);
	} finally {
		deps.create.update(jobId, (j) => {
			for (const page of Object.values(j.pages)) if (page.status === "running") page.status = "pending";
			const unfinished = Object.values(j.pages).some((p) => p.status === "pending");
			j.state = controller.signal.aborted || unfinished || fatal !== undefined ? "stopped" : "done";
			if (blocked) j.blocked = blocked;
			if (fatal) j.fatal = fatal;
		});
		if (running.get(jobId) === controller) running.delete(jobId);
	}
}

export interface StartCreateOptions {
	/** Only these pages (a retry); default = the unfinished pages (or every page with `more`). */
	pages?: number[];
	/** Ask for further, different questions on top of the drafts the pages already have. */
	more?: boolean;
}

/**
 * Start (or resume) a job's run and return at once. `settled` resolves when the
 * run has ended (a test seam; the route ignores it). A run already in flight
 * is left alone (`started: false`).
 */
export function startCreateJob(
	id: string,
	opts: StartCreateOptions = {},
	deps: CreateDeps = defaultCreateDeps(),
): { started: boolean; settled: Promise<void> } {
	const job = requireJob(id, deps);
	if (running.has(id)) return { started: false, settled: Promise.resolve() };

	const all = pageNumbers(job);
	const mode: RunMode = opts.more ? "more" : "resume";
	let todo: number[];
	if (opts.pages) {
		todo = [...new Set(opts.pages)].filter((n) => all.includes(n)).sort((a, b) => a - b);
		if (todo.length === 0) throw new CreateInputError("None of these pages belongs to the job", 400);
	} else if (opts.more) {
		todo = all;
	} else {
		todo = all.filter((n) => job.pages[String(n)]!.status !== "done");
	}
	if (todo.length === 0) return { started: false, settled: Promise.resolve() };

	const controller = new AbortController();
	running.set(id, controller);
	return { started: true, settled: runJob(id, todo, mode, controller, deps) };
}

/** Stop a live run: the pages in flight go back to pending, the job to "stopped". False if nothing runs. */
export function stopCreateJob(id: string): boolean {
	const controller = running.get(id);
	if (!controller) return false;
	controller.abort();
	return true;
}

export function deleteCreateJob(id: string, deps: CreateDeps = defaultCreateDeps()): void {
	requireJob(id, deps);
	if (running.has(id)) throw new CreateInputError("The job is still running — stop it first", 409);
	deps.create.remove(id);
}

// ─── drafts ──────────────────────────────────────────────────────────────────

/** Throw a draft away (soft: it can be restored until the job is deleted). An adopted draft is a card now. */
export function setQuestionDeleted(id: string, questionId: string, deleted: boolean, deps: CreateDeps = defaultCreateDeps()): McqQuestion {
	requireJob(id, deps);
	const page = pageOfQuestionId(questionId);
	const result = page === null ? null : deps.create.readPage(id, page);
	const question = result?.questions.find((q) => q.id === questionId);
	if (!result || !question) throw new CreateInputError("Unknown question", 404);
	if (question.adopted && deleted) throw new CreateInputError("This question is already a card — delete the card in Study", 409);
	question.deleted = deleted;
	savePage(id, result, deps);
	return question;
}

export interface AdoptResult {
	/** Drafts that became cards now. */
	adopted: number;
	/** Drafts left out: deleted, or already adopted earlier. */
	skipped: number;
}

/**
 * Turn drafts into study cards of a course: every undeleted, not-yet-adopted
 * draft of the job, or just `questionIds`. The card id is derived from job +
 * question, so adopting the same draft twice can never create two cards.
 */
export function adoptQuestions(
	id: string,
	input: { courseId: string; questionIds?: string[] },
	deps: CreateDeps = defaultCreateDeps(),
): AdoptResult {
	const job = requireJob(id, deps);
	const course = deps.study.readCourses().find((c) => c.id === input.courseId);
	if (!course) throw new CreateInputError("Unknown course", 404);
	const wanted = input.questionIds ? new Set(input.questionIds) : null;

	const at = deps.now().toISOString();
	const cards: StudyCard[] = [];
	const touched: McqPageResult[] = [];
	let skipped = 0;
	for (const n of pageNumbers(job)) {
		const result = deps.create.readPage(id, n);
		if (!result) continue;
		let changed = false;
		for (const q of result.questions) {
			if (wanted && !wanted.has(q.id)) continue;
			if (q.deleted || q.adopted) {
				skipped++;
				continue;
			}
			const cardId = `crt_${job.id}_${q.id}`;
			cards.push({
				id: cardId,
				courseId: course.id,
				topic: job.name,
				kind: "mcq",
				fields: mcqCardFields(q, `${job.name} · p. ${q.page}`),
				tags: [`Create::${job.name.replace(/[^\p{L}\p{N}_-]+/gu, "_")}`],
				core: false,
				origin: { kind: "pdf", jobId: job.id, page: q.page },
				createdAt: at,
			});
			q.adopted = { courseId: course.id, cardId, at };
			changed = true;
		}
		if (changed) touched.push(result);
	}
	if (cards.length > 0) {
		// Cards first: a crash before the marks only means the next adopt writes the same card ids again.
		deps.study.upsertCards(cards);
		for (const result of touched) savePage(id, result, deps);
	}
	return { adopted: cards.length, skipped };
}

