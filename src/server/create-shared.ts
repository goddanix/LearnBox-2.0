/**
 * What the Create runners share (Learnbox 2.0, 2026-11): the collaborators of a
 * run (stores, Claude, the PDF engine), the table of live runs, honest reading of
 * a job record after a restart, and the JSON ask with its repair retry. The MC-test
 * runner (create.ts) and the card runner (create-cards.ts) both build on it.
 */

import { ClaudeAskError, askClaude, type AskClaude } from "../agent/claude-ask.ts";
import { repairSuffix } from "../agent/create/mcq-prompts.ts";
import { getHeadless } from "../agent/subagents/headless.ts";
import { pdfExtract, pdfPageLines, type PdfTextLine } from "../agent/subagents/pdf-ops.ts";
import { CreateInputError, type CreateJob, type CreateJobSummary, type LectureSource } from "../core/contracts.ts";
import { countPages, parseModelJson } from "../core/create.ts";
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

/** Jobs with a live run, by id (the abort handle). Kept on globalThis: Next may load this module once per
 *  route bundle, and the start route and the list route must see the same runs. */
const runs = globalThis as typeof globalThis & { __lbCreateRuns?: Map<string, AbortController> };
export const running = (runs.__lbCreateRuns ??= new Map<string, AbortController>());

export const pad = (page: number) => String(page).padStart(3, "0");
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A job record as stored, but with a run that no longer exists reported honestly:
 *  "interrupted", its unfinished pages back to "pending". */
export function reconciled(job: CreateJob, deps: CreateDeps): CreateJob {
	if (job.state !== "running" || running.has(job.id)) return job;
	return (
		deps.create.update(job.id, (j) => {
			j.state = "interrupted";
			for (const page of Object.values(j.pages)) if (page.status === "running") page.status = "pending";
		}) ?? job
	);
}

export function summarize(job: CreateJob): CreateJobSummary {
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

export function requireJob(id: string, deps: CreateDeps): CreateJob {
	const job = /^[A-Za-z0-9_-]+$/.test(id) ? deps.create.get(id) : null;
	if (!job) throw new CreateInputError("Unknown job", 404);
	return reconciled(job, deps);
}

/** The whole run must stop: the sign-in is gone, the plan's limit is reached, or the CLI is missing. */
export class RunBlocked extends Error {}

export const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** Ask for a JSON object; one repair retry for an unreadable answer, one plain retry for a failed call. */
export async function askJson(
	deps: Pick<CreateDeps, "ask" | "retryDelayMs">,
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

export interface AdoptResult {
	/** Drafts that became cards now. */
	adopted: number;
	/** Drafts left out: deleted, or already adopted earlier. */
	skipped: number;
}
