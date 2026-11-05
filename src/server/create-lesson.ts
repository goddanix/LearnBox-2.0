/**
 * The lesson-cards runner (Learnbox 2.0, 2026-11, Slice 9c): statements of a lesson → draft cards.
 *
 * A lesson job takes the statements of the knowledge graph one lesson touched (or that the learner picked on the
 * graph) and asks Claude about each — one `claude -p` call per statement, on the learner's own sign-in — for up to
 * three cards. One "page" of the job is one statement. The answers are DRAFTS in the job's own folder; they become
 * study cards only when the learner adopts them into a course, and then ALWAYS as core knowledge, tied back to the
 * statement they came from (origin "graph"). The lesson keeps the ids of the cards made from it, so the review
 * screen can lead back to it. The run machinery (live runs, interrupted jobs, blocked sign-in) is shared with the
 * other Create runners (create-shared.ts).
 */

import { ClaudeAskError } from "../agent/claude-ask.ts";
import { courseHint, lessonStatementPrompt, lessonSystemPrompt } from "../agent/create/lesson-prompts.ts";
import {
	CREATE_SCHEMA,
	CreateInputError,
	type CreateJobSummary,
	type CreatePage,
	type LessonDraft,
	type LessonJob,
	type LessonJobDetail,
	type LessonJobPageView,
	type LessonPageResult,
	type LessonSource,
	type LessonStatement,
	type StudyCard,
	LESSON_STATEMENTS_MAX,
} from "../core/contracts.ts";
import type { GraphSnapshot } from "../core/contracts/graph.ts";
import { CardEditError } from "../core/card-edit.ts";
import {
	applyLessonEdit,
	cleanLessonSettings,
	existingCardTexts,
	lessonDrafts,
	lessonStatements,
	lessonStudyCards,
	nextDraftIndex,
	pickedStatements,
	withCardCounts,
} from "../core/lesson-cards.ts";
import { pageNumbers } from "../core/create.ts";
import type { ChatStore } from "../core/ports.ts";
import { type AdoptResult, type CreateDeps, RunBlocked, askJson, defaultCreateDeps, errorText, requireJob, running, summarize } from "./create-shared.ts";
import { graphView } from "./graph.ts";
import { stores } from "./stores.ts";

/** What a lesson run needs on top of the shared collaborators. */
export interface LessonDeps extends CreateDeps {
	chats: ChatStore;
	/** The knowledge graph's propositions and the lessons that touched them. */
	graph: () => Pick<GraphSnapshot, "propositions" | "nodeSessions">;
}

/** The seams of a lesson run in their live form. */
const liveSeams = (): Pick<LessonDeps, "chats" | "graph"> => ({ chats: stores.chatStore, graph: () => graphView() });

export const defaultLessonDeps = (): LessonDeps => ({ ...defaultCreateDeps(), ...liveSeams() });

/** Shared deps → lesson deps: whatever seams the caller did not name are the live ones. */
export const withLessonSeams = (deps: CreateDeps): LessonDeps => ({ ...liveSeams(), ...deps });

/** The name of a job made from a graph pick (a lesson's job is named after the lesson). */
export const GRAPH_PICK_NAME = "Graph selection";

// ─── reading ─────────────────────────────────────────────────────────────────

export function requireLesson(id: string, deps: CreateDeps): LessonJob {
	const job = requireJob(id, deps);
	if (job.kind !== "lesson") throw new CreateInputError("This is not a lesson-cards job", 409);
	return job;
}

const live = (cards: readonly LessonDraft[]): LessonDraft[] => cards.filter((c) => !c.deleted);

export function getLessonJob(id: string, deps: CreateDeps = defaultCreateDeps()): LessonJobDetail {
	const job = requireLesson(id, deps);
	const pages: LessonJobPageView[] = pageNumbers(job).map((page) => {
		const meta = job.pages[String(page)]!;
		const result = deps.create.readLessonPage(id, page);
		return {
			page,
			status: meta.status,
			...(meta.error ? { error: meta.error } : {}),
			statement: job.statements[page - 1]!,
			cards: result?.cards ?? [],
			note: result?.note ?? "",
		};
	});
	return { job: summarize(job), settings: job.settings, ...(job.chatId ? { chatId: job.chatId } : {}), pages };
}

// ─── the statements a new job can be made from ───────────────────────────────

export interface LessonSourceInput {
	/** A lesson (chat): its statements are the propositions it touched. */
	chatId?: string;
	/** Or propositions picked on the graph. */
	nodeIds?: string[];
}

const idList = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0))] : []);

/** The plain statements of a source, with the title and course of the lesson. */
function sourceStatements(input: LessonSourceInput, deps: LessonDeps): { chatId?: string; title: string; courseId?: string; statements: LessonStatement[] } {
	if (input.chatId) {
		const chat = deps.chats.getChat(input.chatId);
		if (!chat) throw new CreateInputError("Unknown lesson", 404);
		return { chatId: chat.id, title: chat.title, ...(chat.courseId ? { courseId: chat.courseId } : {}), statements: lessonStatements(deps.graph(), chat.id) };
	}
	const nodeIds = idList(input.nodeIds);
	if (nodeIds.length === 0) throw new CreateInputError("Name a lesson or some statements", 400);
	const statements = pickedStatements(deps.graph(), nodeIds);
	if (statements.length === 0) throw new CreateInputError("These statements are no longer in the graph", 404);
	return { title: GRAPH_PICK_NAME, statements };
}

/** What the new-job form needs: the statements with the number of cards each already has. */
export function lessonSource(input: LessonSourceInput, deps: LessonDeps = defaultLessonDeps()): LessonSource {
	const found = sourceStatements(input, deps);
	return {
		...(found.chatId ? { chatId: found.chatId } : {}),
		title: found.title,
		...(found.courseId ? { courseId: found.courseId } : {}),
		statements: withCardCounts(found.statements, deps.study.readCards()),
	};
}

// ─── creating a job ──────────────────────────────────────────────────────────

export interface CreateLessonJobInput extends LessonSourceInput {
	/** The statements to make cards from (node ids of the source). */
	statementIds: string[];
	/** The subject whose core knowledge the cards become. */
	courseId: string;
	settings?: unknown;
	/** Start the run right away (default). */
	autostart?: boolean;
}

export function createLessonJob(input: CreateLessonJobInput, deps: LessonDeps = defaultLessonDeps()): CreateJobSummary {
	const course = deps.study.readCourses().find((c) => c.id === input.courseId);
	if (!course) throw new CreateInputError("Unknown course", 404);

	const found = sourceStatements(input, deps);
	const wanted = new Set(idList(input.statementIds));
	if (wanted.size === 0) throw new CreateInputError("Pick at least one statement", 400);
	if (wanted.size > LESSON_STATEMENTS_MAX) throw new CreateInputError(`A job takes at most ${LESSON_STATEMENTS_MAX} statements`, 400);
	const statements = found.statements.filter((s) => wanted.has(s.nodeId));
	if (statements.length !== wanted.size) throw new CreateInputError("A statement is no longer in the lesson — reload the list", 404);

	const id = `crt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
	const job: LessonJob = {
		v: CREATE_SCHEMA,
		id,
		kind: "lesson",
		name: found.title,
		nPages: statements.length,
		settings: cleanLessonSettings(input.settings),
		courseId: course.id,
		...(found.chatId ? { chatId: found.chatId } : {}),
		statements,
		courseNote: courseHint(course),
		state: "queued",
		createdAt: deps.now().toISOString(),
		pages: Object.fromEntries(statements.map((_, i) => [String(i + 1), { status: "pending", count: 0, adopted: 0 }])),
	};
	deps.create.createJob(job);
	if (input.autostart !== false) startLessonJob(id, {}, deps);
	return summarize(deps.create.get(id) ?? job);
}

// ─── the run ─────────────────────────────────────────────────────────────────

const pageMeta = (result: LessonPageResult, statement: LessonStatement) => {
	const cards = live(result.cards);
	return { count: cards.length, adopted: cards.filter((c) => c.adopted).length, topic: statement.name, skipped: result.cards.length === 0 };
};

/** Write one statement's drafts and keep the job's counters for it in step. */
function savePage(job: LessonJob, result: LessonPageResult, deps: CreateDeps): void {
	deps.create.writeLessonPage(job.id, result);
	deps.create.update(job.id, (j) => {
		const page = j.pages[String(result.page)];
		if (page) Object.assign(page, pageMeta(result, job.statements[result.page - 1]!));
	});
}

async function processLessonPage(job: LessonJob, n: number, signal: AbortSignal, deps: CreateDeps): Promise<void> {
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
		const statement = job.statements[n - 1];
		if (!statement) throw new Error("This statement is not part of the job.");
		// A new run of a statement keeps the cards already adopted (they are study cards now), with their ids.
		const before = deps.create.readLessonPage(job.id, n)?.cards ?? [];
		const kept = before.filter((c) => c.adopted);
		const ledger = existingCardTexts(deps.study.readCards(), statement.nodeId);

		const answer = await askJson(deps, {
			prompt: lessonStatementPrompt({
				lesson: job.name,
				statement,
				position: n,
				total: job.statements.length,
				others: job.statements,
				existing: ledger,
			}),
			system: lessonSystemPrompt(job.settings.language, job.settings.maxPerStatement, job.courseNote),
			cwd: deps.create.workDir(job.id),
			model: job.settings.model,
			signal,
		});

		const { cards, note } = lessonDrafts(answer, n, job.settings.maxPerStatement, nextDraftIndex(before));
		savePage(job, { page: n, nodeId: statement.nodeId, cards: [...kept, ...cards], note }, deps);
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

async function runJob(jobId: string, pages: number[], controller: AbortController, deps: CreateDeps): Promise<void> {
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
		if (!job || job.kind !== "lesson") return;
		const queue = [...pages];
		const worker = async () => {
			while (!controller.signal.aborted) {
				const n = queue.shift();
				if (n === undefined) return;
				const current = deps.create.get(jobId);
				if (!current || current.kind !== "lesson") return; // deleted meanwhile
				try {
					await processLessonPage(current, n, controller.signal, deps);
				} catch (err) {
					if (!(err instanceof RunBlocked)) throw err;
					blocked ??= err.message;
					controller.abort(); // every further statement would fail the same way
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

export interface StartLessonOptions {
	/** Only these statements (a retry, or a new run of one); default = the unfinished ones. */
	pages?: number[];
}

/**
 * Start (or resume) a run and return at once. `settled` resolves when the run has ended (a test seam).
 * A run already in flight is left alone (`started: false`).
 */
export function startLessonJob(id: string, opts: StartLessonOptions = {}, deps: CreateDeps = defaultCreateDeps()): { started: boolean; settled: Promise<void> } {
	const job = requireLesson(id, deps);
	if (running.has(id)) return { started: false, settled: Promise.resolve() };

	const all = pageNumbers(job);
	let todo: number[];
	if (opts.pages) {
		todo = [...new Set(opts.pages)].filter((n) => all.includes(n)).sort((a, b) => a - b);
		if (todo.length === 0) throw new CreateInputError("None of these statements belongs to the job", 400);
	} else {
		todo = all.filter((n) => job.pages[String(n)]!.status !== "done");
	}
	if (todo.length === 0) return { started: false, settled: Promise.resolve() };

	const controller = new AbortController();
	running.set(id, controller);
	return { started: true, settled: runJob(id, todo, controller, deps) };
}

// ─── drafts ──────────────────────────────────────────────────────────────────

/** "p003-c02" → statement 3; null for any other shape. */
export function pageOfLessonCardId(cardId: string): number | null {
	const m = /^p(\d{3})-c\d+$/.exec(cardId);
	return m ? Number(m[1]) : null;
}

/** The page of a draft, if it may be changed now (its statement is not being worked on). */
function editablePage(job: LessonJob, page: number, deps: CreateDeps): LessonPageResult {
	const meta = job.pages[String(page)];
	if (!meta) throw new CreateInputError("Unknown statement", 404);
	if (meta.status === "running") throw new CreateInputError("This statement is being worked on — try again in a moment", 409);
	const result = deps.create.readLessonPage(job.id, page);
	if (!result) throw new CreateInputError("This statement has no cards yet — process it first", 409);
	return result;
}

/**
 * Change a draft card: its texts, whether it is selected, throw it away or bring it back. A card that is a study
 * card now has to be changed in Study. An invalid change (empty side, broken gap text) is refused whole.
 */
export function patchLessonCard(id: string, cardId: string, body: Record<string, unknown>, deps: CreateDeps = defaultCreateDeps()): LessonDraft {
	const job = requireLesson(id, deps);
	const page = pageOfLessonCardId(cardId);
	if (page === null) throw new CreateInputError("Unknown card", 404);
	const result = editablePage(job, page, deps);
	const card = result.cards.find((c) => c.id === cardId);
	if (!card) throw new CreateInputError("Unknown card", 404);
	if (card.adopted) throw new CreateInputError("This card is already a study card — change it in Study", 409);
	try {
		applyLessonEdit(card, body);
	} catch (err) {
		if (err instanceof CardEditError) throw new CreateInputError(err.message, 400);
		throw err;
	}
	savePage(job, result, deps);
	return card;
}

/** Select or unselect many drafts for adoption at once; returns how many changed. */
export function setLessonInclude(id: string, input: { cardIds: string[]; include: boolean }, deps: CreateDeps = defaultCreateDeps()): number {
	const job = requireLesson(id, deps);
	const wanted = new Set(input.cardIds);
	let changed = 0;
	for (const n of pageNumbers(job)) {
		const result = deps.create.readLessonPage(id, n);
		if (!result || job.pages[String(n)]!.status === "running") continue;
		let touched = false;
		for (const card of result.cards) {
			if (!wanted.has(card.id) || card.adopted || card.include === input.include) continue;
			card.include = input.include;
			changed++;
			touched = true;
		}
		if (touched) savePage(job, result, deps);
	}
	return changed;
}

// ─── adoption ────────────────────────────────────────────────────────────────

/**
 * Turn drafts into study cards of a course: every undeleted, not-yet-adopted draft of the job that is selected, or
 * just `cardIds`, whatever their selection. They are core knowledge (tier 1) tied to their statement; the study
 * card ids derive from job + draft, so adopting a draft twice cannot create two cards. The lesson the job came from
 * learns the ids of the cards made from it.
 */
export function adoptLessonCards(id: string, input: { courseId: string; cardIds?: string[] }, deps: LessonDeps = defaultLessonDeps()): AdoptResult {
	const job = requireLesson(id, deps);
	const course = deps.study.readCourses().find((c) => c.id === input.courseId);
	if (!course) throw new CreateInputError("Unknown course", 404);
	const wanted = input.cardIds ? new Set(input.cardIds) : null;

	const at = deps.now().toISOString();
	const cards: StudyCard[] = [];
	const touched: LessonPageResult[] = [];
	let skipped = 0;
	let adopted = 0;
	for (const n of pageNumbers(job)) {
		const result = deps.create.readLessonPage(id, n);
		const statement = job.statements[n - 1];
		if (!result || !statement) continue;
		let changed = false;
		for (const draft of result.cards) {
			if (wanted ? !wanted.has(draft.id) : !draft.include) continue; // not selected: stays a draft
			if (draft.deleted || draft.adopted) {
				skipped++;
				continue;
			}
			const made = lessonStudyCards(draft, { jobId: job.id, jobName: job.name, courseId: course.id, statement, at });
			if (made.length === 0) {
				skipped++;
				continue;
			}
			cards.push(...made);
			draft.adopted = { courseId: course.id, cardId: made[0]!.id, at };
			adopted++;
			changed = true;
		}
		if (changed) touched.push(result);
	}
	if (cards.length > 0) {
		// Cards first: a crash before the marks only means the next adopt writes the same card ids again.
		deps.study.upsertCards(cards);
		for (const result of touched) savePage(job, result, deps);
		if (job.chatId) deps.chats.linkCards(job.chatId, cards.map((c) => c.id));
	}
	return { adopted, skipped };
}
