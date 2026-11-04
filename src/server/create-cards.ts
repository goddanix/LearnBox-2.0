/**
 * The cards runner (Learnbox 2.0, 2026-11): PDF → draft cards, ported from MedAnki's pipeline.
 *
 * A cards job walks the pages of one library PDF. Per page it reads the layout (text lines with ids and
 * emphasis, figures, legends), renders the page image, and asks Claude (one `claude -p` call, on the
 * learner's own sign-in) for cards; the answer is normalised into DRAFTS with their safety nets
 * (core/card-normalize.ts), the flagged ones get a second look by the critic, and the pictures of the cards
 * (occlusion masks, context figures) are rendered. Once per run, before the first page: whether Latin
 * anatomical terms are on, the page titles, and a small glossary of canonical spellings. After the last
 * page, practically identical cards across the whole PDF are thrown away (soft, restorable).
 *
 * Drafts live in the job's folder; they become study cards only when the learner adopts them into a course
 * (core/card-adopt.ts maps the fields). A page that is run again keeps the learner's own cards and the
 * ones already adopted. The run machinery (live runs, interrupted jobs, blocked sign-in) is shared with the
 * MC-test runner (create-shared.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { ClaudeAskError } from "../agent/claude-ask.ts";
import { PAGE_IMAGE_LONG_SIDE, type PdfSession, openPdfSession, realizeMedia } from "../agent/create/card-media.ts";
import {
	CRITIC_SYSTEM,
	cardPagePrompt,
	cardSystemPrompt,
	criticPrompt,
	focusHint,
	glossaryHint,
	glossaryPrompt,
	glossarySystemPrompt,
	kindHint,
	vocabSystemPrompt,
} from "../agent/create/card-prompts.ts";
import { type LayoutOptions, pdfLayouts } from "../agent/layout/pdf-raw.ts";
import { type OcrLine, recognizeImage } from "../agent/layout/vision.ts";
import { pdfPageCount } from "../agent/subagents/pdf-ops.ts";
import { draftToStudyCards, mediaOf } from "../core/card-adopt.ts";
import { autoMark } from "../core/card-dedupe.ts";
import { normalizePage } from "../core/card-normalize.ts";
import { applyVerdicts, cardBrief, criticPageText, flaggedCards, glossaryMaterial, parseGlossary, samplePages } from "../core/card-review.ts";
import { cleanCardSettings } from "../core/card-settings.ts";
import {
	CREATE_SCHEMA,
	CreateInputError,
	type CardsJob,
	type CreateJobSummary,
	type CreatePage,
	type StudyCard,
} from "../core/contracts.ts";
import { type CardDraft, type CardJobPageView, type CardPageResult, type CardsJobDetail, type GlossaryTerm, VOCAB_MAX_PER_PAGE } from "../core/contracts/create-cards.ts";
import type { PageLayout } from "../core/contracts/page-layout.ts";
import { clampPageRange, pageNumbers } from "../core/create.ts";
import {
	type AdoptResult,
	type CreateDeps,
	RunBlocked,
	askJson,
	defaultCreateDeps,
	errorText,
	pad,
	requireJob,
	running,
	summarize,
} from "./create-shared.ts";

/** What a cards run needs on top of the shared collaborators. */
export interface CardsDeps extends CreateDeps {
	/** The PDF, opened once for a run. */
	openPdf: (file: string) => Promise<PdfSession>;
	/** Layouts (text lines, figures, legends; text recognition where available) of some pages. */
	layouts: (file: string, pages: readonly number[], opts?: LayoutOptions) => Promise<Map<number, PageLayout>>;
	/** Text recognition on a PNG file (the printed numbers inside figures). */
	recognize: (pngPath: string) => Promise<OcrLine[]>;
	/** Where the pictures of adopted cards go (the study media folder). */
	studyMediaDir: string;
}

/** The seams of a cards run in their live form. */
const liveSeams = (): Pick<CardsDeps, "openPdf" | "layouts" | "recognize" | "studyMediaDir"> => ({
	openPdf: openPdfSession,
	layouts: (file, pages, opts) => pdfLayouts(file, pages, opts),
	recognize: (pngPath) => recognizeImage(pngPath),
	studyMediaDir: PATHS.studyMedia,
});

export const defaultCardsDeps = (): CardsDeps => ({ ...defaultCreateDeps(), ...liveSeams() });

/** Shared deps → cards deps: whatever seams the caller did not name are the live ones. */
export const withCardSeams = (deps: CreateDeps): CardsDeps => ({ ...liveSeams(), ...deps });

/** The model for the small, mechanical glossary call (no judgement about the cards themselves). */
const FAST_MODEL = "haiku";

const cardNumber = (id: string): number => Number(/-c(\d+)$/.exec(id)?.[1] ?? 0);

// ─── reading ─────────────────────────────────────────────────────────────────

function requireCards(id: string, deps: CreateDeps): CardsJob {
	const job = requireJob(id, deps);
	if (job.kind !== "cards") throw new CreateInputError("This is not a cards job", 409);
	return job;
}

const live = (cards: readonly CardDraft[]): CardDraft[] => cards.filter((c) => !c.deleted);

export function getCardsJob(id: string, deps: CreateDeps = defaultCreateDeps()): CardsJobDetail {
	const job = requireCards(id, deps);
	const pages: CardJobPageView[] = pageNumbers(job).map((page) => {
		const meta = job.pages[String(page)]!;
		const result = deps.create.readCardPage(id, page);
		return {
			page,
			status: meta.status,
			...(meta.error ? { error: meta.error } : {}),
			topic: result?.topic ?? meta.topic ?? "",
			skipped: result?.skip ?? false,
			skipReason: result?.skipReason ?? "",
			cards: result?.cards ?? [],
			dropped: result?.dropped.length ?? 0,
		};
	});
	return { job: summarize(job), settings: job.settings, pages };
}

// ─── creating a job ──────────────────────────────────────────────────────────

export interface CreateCardsJobInput {
	lectureId: string;
	settings?: unknown;
	/** Start the run right away (default). */
	autostart?: boolean;
}

export async function createCardsJob(input: CreateCardsJobInput, deps: CardsDeps = defaultCardsDeps()): Promise<CreateJobSummary> {
	const lecture = deps.library.get(input.lectureId);
	const pdf = deps.library.pdfPath(input.lectureId);
	if (!lecture || !pdf) throw new CreateInputError("Unknown PDF — add it to the library first", 404);
	const nPages = lecture.pages ?? (await pdfPageCount(pdf));

	const settings = cleanCardSettings(input.settings);
	if (settings.pageTo > 0 && settings.pageFrom > settings.pageTo) {
		throw new CreateInputError("The page range is wrong: “from” is larger than “to”", 400);
	}
	const range = clampPageRange(settings.pageFrom, settings.pageTo, nPages);
	settings.pageFrom = range.from;
	settings.pageTo = range.to;

	const id = `crt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
	const job: CardsJob = {
		v: CREATE_SCHEMA,
		id,
		kind: "cards",
		name: lecture.title,
		lectureId: lecture.id,
		nPages,
		settings,
		state: "queued",
		createdAt: deps.now().toISOString(),
		pages: Object.fromEntries(Array.from({ length: range.to - range.from + 1 }, (_, i) => [String(range.from + i), { status: "pending", count: 0, adopted: 0 }])),
	};
	deps.create.createJob(job);
	if (input.autostart !== false) startCardsJob(id, {}, deps);
	return summarize(deps.create.get(id) ?? job);
}

// ─── the run ─────────────────────────────────────────────────────────────────

interface RunContext {
	pdf: string;
	session: PdfSession;
	signal: AbortSignal;
	deps: CardsDeps;
}

const latinEnabled = (job: CardsJob): boolean =>
	job.settings.latinTerms === "on" ? true : job.settings.latinTerms === "off" ? false : /anatom/i.test(job.name);

/** The page layout, read once and kept in the job's folder (a rerun and the focus screen need no second reading). */
async function layoutOf(jobId: string, n: number, ctx: RunContext): Promise<PageLayout> {
	const cached = ctx.deps.create.readLayout(jobId, n);
	if (cached) return cached;
	const layout = (await ctx.deps.layouts(ctx.pdf, [n])).get(n);
	if (!layout) throw new Error(`page ${n} could not be read`);
	ctx.deps.create.writeLayout(jobId, n, layout);
	return layout;
}

const setJob = (jobId: string, deps: CreateDeps, change: (job: CardsJob) => void): void => {
	deps.create.update(jobId, (j) => {
		if (j.kind === "cards") change(j);
	});
};

/** Latin on/off, the page titles and the glossary: once per job, before its first page. */
async function prepareRun(jobId: string, ctx: RunContext): Promise<void> {
	const { deps, signal } = ctx;
	const job = deps.create.get(jobId);
	if (!job || job.kind !== "cards") return;
	const work = deps.create.workDir(jobId);

	const latin = job.latin ?? latinEnabled(job);
	if (job.latin === undefined) setJob(jobId, deps, (j) => (j.latin = latin));

	if (!job.headings) {
		const pages = pageNumbers(job);
		const wanted = [...new Set([Math.max(1, pages[0]! - 1), ...pages, Math.min(job.nPages, pages[pages.length - 1]! + 1)])];
		const found = await ctx.deps.layouts(ctx.pdf, wanted, { ocr: false, legends: false }).catch(() => new Map<number, PageLayout>());
		const headings = Object.fromEntries([...found].map(([n, l]) => [String(n), l.title]));
		setJob(jobId, deps, (j) => (j.headings = headings));
	}

	if (!job.settings.vocab && job.glossary === undefined) {
		let glossary: GlossaryTerm[] = [];
		const sample = samplePages(pageNumbers(job));
		const layouts = await Promise.all(sample.map((n) => layoutOf(jobId, n, ctx).then((layout) => ({ page: n, layout }), () => null)));
		const material = glossaryMaterial(layouts.filter((l): l is { page: number; layout: PageLayout } => l !== null));
		if (material.trim()) {
			try {
				glossary = parseGlossary(
					await askJson(deps, { prompt: glossaryPrompt(job.name, material), system: glossarySystemPrompt(latin), cwd: work, model: FAST_MODEL, signal }),
				);
			} catch (err) {
				// a comfort feature: a failed call leaves the glossary empty, but a lost sign-in / abort stops the run
				if (err instanceof RunBlocked || signal.aborted || (err instanceof ClaudeAskError && err.kind === "aborted")) throw err;
			}
		}
		setJob(jobId, deps, (j) => (j.glossary = glossary));
	}
}

const pageMeta = (result: CardPageResult) => {
	const cards = live(result.cards);
	return { count: cards.length, adopted: cards.filter((c) => c.adopted).length, topic: result.topic, skipped: result.skip };
};

/** Write one page's drafts and keep the job's counters for that page in step. */
function savePage(jobId: string, result: CardPageResult, deps: CreateDeps): void {
	deps.create.writeCardPage(jobId, result);
	deps.create.update(jobId, (j) => {
		const page = j.pages[String(result.page)];
		if (page) Object.assign(page, pageMeta(result));
	});
}

function systemFor(job: CardsJob): string {
	const s = job.settings;
	if (s.vocab) return vocabSystemPrompt(s.vocabLang, VOCAB_MAX_PER_PAGE);
	return (
		cardSystemPrompt({ density: s.density, language: s.language, latin: job.latin ?? latinEnabled(job), atlas: s.wholeImageCards }) +
		glossaryHint(job.glossary ?? []) +
		focusHint(s.focusTopics, s.focusStrict) +
		kindHint(s.kind)
	);
}

/** The critic's second look at the flagged cards of a page; a failed call leaves them as they are. */
async function critique(job: CardsJob, layout: PageLayout, cards: CardDraft[], work: string, ctx: RunContext): Promise<void> {
	const flagged = flaggedCards(cards);
	if (flagged.length === 0) return;
	try {
		const raw = await askJson(ctx.deps, {
			prompt: criticPrompt(criticPageText(layout), flagged.map(cardBrief)),
			system: CRITIC_SYSTEM,
			cwd: work,
			model: job.settings.model,
			signal: ctx.signal,
		});
		applyVerdicts(flagged, raw);
	} catch (err) {
		if (err instanceof RunBlocked || ctx.signal.aborted || (err instanceof ClaudeAskError && err.kind === "aborted")) throw err;
	}
}

async function processCardPage(job: CardsJob, n: number, ctx: RunContext): Promise<void> {
	const { deps, signal } = ctx;
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
		const work = deps.create.workDir(job.id);
		const imageRel = path.join("pages", `p${pad(n)}.png`);
		const imageFile = path.join(work, imageRel);
		if (!fs.existsSync(imageFile)) {
			fs.mkdirSync(path.dirname(imageFile), { recursive: true });
			fs.writeFileSync(imageFile, await ctx.session.renderPage(n, PAGE_IMAGE_LONG_SIDE));
		}
		const layout = await layoutOf(job.id, n, ctx);

		// The learner's own cards and the ones already adopted survive a new run of the page, with their ids.
		const before = deps.create.readCardPage(job.id, n)?.cards ?? [];
		const kept = before.filter((c) => c.manual || c.adopted);
		const headings = job.headings ?? {};
		const answer = await askJson(deps, {
			prompt: cardPagePrompt({
				docName: job.name,
				page: n,
				nPages: job.nPages,
				imageRel,
				layout,
				prevTitle: headings[String(n - 1)] ?? "",
				nextTitle: headings[String(n + 1)] ?? "",
			}),
			system: systemFor(job),
			cwd: work,
			model: job.settings.model,
			signal,
		});

		const result = normalizePage(answer, layout, n, job.settings, Math.max(0, ...kept.map((c) => cardNumber(c.id))) + 1);
		await critique(job, layout, result.cards, work, ctx);
		result.cards = [...kept, ...result.cards].sort((a, b) => cardNumber(a.id) - cardNumber(b.id));
		await realizeMedia(result, {
			region: (box, px) => ctx.session.renderRegion(n, box, px),
			mediaDir: deps.create.mediaDir(job.id),
			recognize: deps.recognize,
		});
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

/** After the last page: practically identical cards of the whole PDF are thrown away (soft). Returns how many. */
export function finalizeDuplicates(jobId: string, deps: CreateDeps): number {
	const job = deps.create.get(jobId);
	if (!job) return 0;
	const pages = pageNumbers(job).flatMap((n) => {
		const result = deps.create.readCardPage(jobId, n);
		return result ? [result] : [];
	});
	const deletedBefore = new Set(pages.flatMap((p) => p.cards.filter((c) => c.deleted).map((c) => c.id)));
	const removed = autoMark(pages);
	for (const result of pages) {
		if (result.cards.some((c) => c.deleted && !deletedBefore.has(c.id))) savePage(jobId, result, deps);
	}
	return removed;
}

async function runJob(jobId: string, pages: number[], controller: AbortController, deps: CardsDeps): Promise<void> {
	let blocked: string | undefined;
	let fatal: string | undefined;
	let session: PdfSession | undefined;
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
		if (!job || job.kind !== "cards") return;
		const pdf = deps.library.pdfPath(job.lectureId);
		if (!pdf) throw new Error("The PDF is no longer in the library.");
		session = await deps.openPdf(pdf);
		const ctx: RunContext = { pdf, session, signal: controller.signal, deps };

		try {
			await prepareRun(jobId, ctx);
		} catch (err) {
			if (!(err instanceof RunBlocked)) throw err;
			blocked = err.message;
			controller.abort();
		}

		const queue = [...pages];
		const worker = async () => {
			while (!controller.signal.aborted) {
				const n = queue.shift();
				if (n === undefined) return;
				const current = deps.create.get(jobId);
				if (!current) return; // deleted meanwhile
				if (current.kind !== "cards") return;
				try {
					await processCardPage(current, n, ctx);
				} catch (err) {
					if (!(err instanceof RunBlocked)) throw err;
					blocked ??= err.message;
					controller.abort(); // every further page would fail the same way
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(job.settings.concurrency, pages.length) }, worker));
		if (!controller.signal.aborted) finalizeDuplicates(jobId, deps);
	} catch (err) {
		fatal = errorText(err).slice(0, 400);
	} finally {
		await session?.close().catch(() => undefined);
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

export interface StartCardsOptions {
	/** Only these pages (a retry, or a new run of a page); default = the unfinished pages. */
	pages?: number[];
}

/**
 * Start (or resume) a run and return at once. `settled` resolves when the run has ended (a test seam).
 * A run already in flight is left alone (`started: false`).
 */
export function startCardsJob(id: string, opts: StartCardsOptions = {}, deps: CardsDeps = defaultCardsDeps()): { started: boolean; settled: Promise<void> } {
	const job = requireCards(id, deps);
	if (running.has(id)) return { started: false, settled: Promise.resolve() };

	const all = pageNumbers(job);
	let todo: number[];
	if (opts.pages) {
		todo = [...new Set(opts.pages)].filter((n) => all.includes(n)).sort((a, b) => a - b);
		if (todo.length === 0) throw new CreateInputError("None of these pages belongs to the job", 400);
	} else {
		todo = all.filter((n) => job.pages[String(n)]!.status !== "done");
	}
	if (todo.length === 0) return { started: false, settled: Promise.resolve() };

	const controller = new AbortController();
	running.set(id, controller);
	return { started: true, settled: runJob(id, todo, controller, deps) };
}

// ─── drafts ──────────────────────────────────────────────────────────────────

function pageOfCardId(cardId: string): number | null {
	const m = /^p(\d{3})-c\d+$/.exec(cardId);
	return m ? Number(m[1]) : null;
}

/** Throw a card away (soft) or bring it back. A card that is a study card now has to be deleted in Study. */
export function setCardDeleted(id: string, cardId: string, deleted: boolean, deps: CreateDeps = defaultCreateDeps()): CardDraft {
	requireCards(id, deps);
	const page = pageOfCardId(cardId);
	const result = page === null ? null : deps.create.readCardPage(id, page);
	const card = result?.cards.find((c) => c.id === cardId);
	if (!result || !card) throw new CreateInputError("Unknown card", 404);
	if (card.adopted && deleted) throw new CreateInputError("This card is already a study card — delete it in Study", 409);
	card.deleted = deleted;
	if (!deleted) {
		card.restored = true; // brought back by the learner: never thrown away by the machine again
		delete card.note;
	}
	savePage(id, result, deps);
	return card;
}

/**
 * Turn drafts into study cards of a course: every undeleted, not-yet-adopted draft of the job, or just
 * `cardIds`. The study card ids derive from job + draft, so adopting a draft twice cannot create two cards.
 */
export function adoptCards(id: string, input: { courseId: string; cardIds?: string[] }, deps: CardsDeps = defaultCardsDeps()): AdoptResult {
	const job = requireCards(id, deps);
	const course = deps.study.readCourses().find((c) => c.id === input.courseId);
	if (!course) throw new CreateInputError("Unknown course", 404);
	const wanted = input.cardIds ? new Set(input.cardIds) : null;

	const at = deps.now().toISOString();
	const cards: StudyCard[] = [];
	const touched: CardPageResult[] = [];
	const media = new Set<string>();
	let skipped = 0;
	for (const n of pageNumbers(job)) {
		const result = deps.create.readCardPage(id, n);
		if (!result) continue;
		let changed = false;
		for (const draft of result.cards) {
			if (wanted && !wanted.has(draft.id)) continue;
			if (draft.deleted || draft.adopted) {
				skipped++;
				continue;
			}
			const made = draftToStudyCards(draft, { jobId: job.id, jobName: job.name, courseId: course.id, at });
			if (made.length === 0) {
				skipped++; // e.g. an occlusion whose pictures were never rendered
				continue;
			}
			cards.push(...made);
			for (const name of mediaOf(draft)) media.add(name);
			draft.adopted = { courseId: course.id, cardId: made[0]!.id, at };
			changed = true;
		}
		if (changed) touched.push(result);
	}
	if (cards.length > 0) {
		// Pictures and cards first: a crash before the marks only means the next adopt writes the same files and card ids again.
		const from = deps.create.mediaDir(id);
		fs.mkdirSync(deps.studyMediaDir, { recursive: true });
		for (const name of media) {
			const target = path.join(deps.studyMediaDir, name);
			if (!fs.existsSync(target)) fs.copyFileSync(path.join(from, name), target);
		}
		deps.study.upsertCards(cards);
		for (const result of touched) savePage(id, result, deps);
	}
	return { adopted: touched.reduce((sum, r) => sum + r.cards.filter((c) => c.adopted?.at === at).length, 0), skipped };
}
