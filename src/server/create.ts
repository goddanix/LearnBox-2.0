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
import { ClaudeAskError } from "../agent/claude-ask.ts";
import { mcqPagePrompt, mcqSystemPrompt } from "../agent/create/mcq-prompts.ts";
import { pdfPageCount } from "../agent/subagents/pdf-ops.ts";
import {
	CREATE_SCHEMA,
	CreateInputError,
	type CreateJob,
	type CreateJobDetail,
	type CreateJobKind,
	type CreateJobPageView,
	type CreateJobSummary,
	type CreatePage,
	type McqJob,
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
	questionId,
	validateMcqQuestion,
} from "../core/create.ts";
import { startCardsJob, withCardSeams } from "./create-cards.ts";
import { type AdoptResult, type CreateDeps, RunBlocked, askJson, defaultCreateDeps, errorText, pad, requireJob, reconciled, running, summarize } from "./create-shared.ts";

export { type AdoptResult, type CreateDeps, defaultCreateDeps } from "./create-shared.ts";

/** Upper bound for the second PDF's text: it rides in EVERY page prompt, so it is kept short. */
const LECTURE_MAX_CHARS = 40_000;
export const LECTURE_TEXT_FILE = "lecture.txt";

// ─── reading jobs ────────────────────────────────────────────────────────────

export function listCreateJobs(deps: CreateDeps = defaultCreateDeps()): CreateJobSummary[] {
	return deps.create.list().map((job) => summarize(reconciled(job, deps)));
}

/** The job as an MC-test job; a job of another kind is refused with a clean 409. */
function requireMcq(id: string, deps: CreateDeps): McqJob {
	const job = requireJob(id, deps);
	if (job.kind !== "mcq") throw new CreateInputError("This is not a multiple-choice job", 409);
	return job;
}

/** What kind of job `id` is (the job route picks the view by it). */
export function createJobKind(id: string, deps: CreateDeps = defaultCreateDeps()): CreateJobKind {
	return requireJob(id, deps).kind;
}

export function getCreateJob(id: string, deps: CreateDeps = defaultCreateDeps()): CreateJobDetail {
	const job = requireMcq(id, deps);
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
	const job: McqJob = {
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

async function processMcqPage(job: McqJob, n: number, mode: RunMode, signal: AbortSignal, deps: CreateDeps): Promise<void> {
	const setPage = (change: (page: CreatePage) => void) =>
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
					if (current.kind !== "mcq") return;
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
 * is left alone (`started: false`). A cards job is run by create-cards.ts
 * (`more` does not apply there: a page that is run again is named in `pages`).
 */
export function startCreateJob(
	id: string,
	opts: StartCreateOptions = {},
	deps: CreateDeps = defaultCreateDeps(),
): { started: boolean; settled: Promise<void> } {
	if (requireJob(id, deps).kind === "cards") return startCardsJob(id, { pages: opts.pages }, withCardSeams(deps));
	const job = requireMcq(id, deps);
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
	requireMcq(id, deps);
	const page = pageOfQuestionId(questionId);
	const result = page === null ? null : deps.create.readPage(id, page);
	const question = result?.questions.find((q) => q.id === questionId);
	if (!result || !question) throw new CreateInputError("Unknown question", 404);
	if (question.adopted && deleted) throw new CreateInputError("This question is already a card — delete the card in Study", 409);
	question.deleted = deleted;
	savePage(id, result, deps);
	return question;
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
	const job = requireMcq(id, deps);
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

