/**
 * Subjects and their topics in Create (Learnbox 2.0, 2026-11), ported from MedAnki's Fächer (app.py, courses.py,
 * topic_assign.py): a subject is a study course with a topic list; the PDFs made for it favour (or are limited to)
 * those topics. The topic list can come from a file (a PDF's text goes to Claude), be matched against the topics set,
 * be tidied into a few main topics, and Claude assigns the drafts of all the subject's PDFs to the topics. The
 * duplicate review also runs over all PDFs of a subject. The rules are core/course-topics.ts and
 * core/course-cards.ts; here: the stores, the files, and Claude.
 *
 * Not ported: deleting a subject (it owns study cards and reviews — a deliberate step of its own), the Anki push, the
 * Obsidian notes per topic (slice 6), and the audio summaries (slice 7).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ASSIGN_SYSTEM, assignPrompt, CONSOLIDATE_SYSTEM, consolidatePrompt, MATCH_SYSTEM, matchPrompt, TOPICS_SYSTEM, topicsPrompt } from "../agent/create/course-prompts.ts";
import { pdfExtract } from "../agent/subagents/pdf-ops.ts";
import { DEFAULT_THRESHOLD, DUPLICATE_NOTE, findGroups, resolveSemanticGroups } from "../core/card-dedupe.ts";
import { cleanTopics } from "../core/card-util.ts";
import { type CardsJob, CreateInputError, type CreateJobSummary, type StudyCourse } from "../core/contracts.ts";
import type {
	AssignStatus,
	CardPageResult,
	CourseDraft,
	CourseDuplicateReview,
	CourseSemanticStep,
	CourseTag,
	CreateCourse,
	TopicProposal,
	TopicsFromFile,
} from "../core/contracts/create-cards.ts";
import { courseGroup, courseTags, type JobDrafts, qualifyDrafts, splitRef } from "../core/course-cards.ts";
import { ASSIGN_BATCH, assignCardText, cleanProposal, mergeTopics, parseAssignments, parseMatches, topicsFromText } from "../core/course-topics.ts";
import { pageNumbers } from "../core/create.ts";
import { clearCards, pageIsFree, pagesToClear, semanticStepOver } from "./create-cards-edit.ts";
import { FAST_MODEL, savePage } from "./create-cards.ts";
import { type CreateDeps, askJson, defaultCreateDeps, errorText, RunBlocked, summarize } from "./create-shared.ts";

/** What the subject features need on top of the shared collaborators. */
export interface CourseDeps extends CreateDeps {
	/** The text of an uploaded PDF (a topic list), cut to `maxChars`. */
	uploadedPdfText: (data: Uint8Array, maxChars: number) => Promise<string>;
}

export const defaultCourseDeps = (): CourseDeps => ({
	...defaultCreateDeps(),
	uploadedPdfText: async (data, maxChars) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-topics-"));
		try {
			const file = path.join(dir, "topics.pdf");
			fs.writeFileSync(file, data);
			return (await pdfExtract(file, "all")).slice(0, maxChars);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
});

/** Characters of an uploaded PDF the topic extraction reads. */
const TOPICS_PDF_CHARS = 15_000;

// ─── the subjects ────────────────────────────────────────────────────────────

function requireCourse(id: string, deps: CreateDeps): StudyCourse {
	const course = deps.study.readCourses().find((c) => c.id === id);
	if (!course) throw new CreateInputError("Unknown course", 404);
	return course;
}

/** The cards jobs made for a subject, oldest first (the order the duplicate review compares them in). */
function jobsOf(courseId: string, deps: CreateDeps): CardsJob[] {
	return deps.create
		.list()
		.filter((j): j is CardsJob => j.kind === "cards" && j.courseId === courseId)
		.reverse();
}

function viewOf(course: StudyCourse, jobs: readonly CardsJob[]): CreateCourse {
	const topics = course.topics ?? [];
	return {
		id: course.id,
		name: course.name,
		topics,
		strict: Boolean(course.strictTopics) && topics.length > 0,
		...(course.deadline ? { deadline: course.deadline } : {}),
		jobs: jobs.length,
		drafts: jobs.reduce((sum, j) => sum + Object.values(j.pages).reduce((n, p) => n + p.count, 0), 0),
	};
}

export function listCourseViews(deps: CreateDeps = defaultCreateDeps()): CreateCourse[] {
	const jobs = deps.create.list().filter((j): j is CardsJob => j.kind === "cards");
	return deps.study.readCourses().map((c) =>
		viewOf(
			c,
			jobs.filter((j) => j.courseId === c.id),
		),
	);
}

export function getCourseView(id: string, deps: CreateDeps = defaultCreateDeps()): CreateCourse {
	return viewOf(requireCourse(id, deps), jobsOf(id, deps));
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The topics count for every PDF of the subject: those that still carry the old list as their focus take the new one. */
function inheritFocus(course: StudyCourse, oldTopics: readonly string[], deps: CreateDeps): void {
	const topics = course.topics ?? [];
	for (const job of jobsOf(course.id, deps)) {
		deps.create.update(job.id, (j) => {
			if (j.kind !== "cards" || !sameList(j.settings.focusTopics, oldTopics)) return;
			j.settings.focusTopics = [...topics];
			j.settings.focusStrict = Boolean(course.strictTopics) && topics.length > 0;
		});
	}
}

/** Save a subject's topics (and the "only these" switch, which needs topics). Returns the saved course. */
function saveTopics(course: StudyCourse, topics: string[], strict: boolean | undefined, deps: CreateDeps): StudyCourse {
	const next: StudyCourse = { ...course, topics, strictTopics: (strict ?? Boolean(course.strictTopics)) && topics.length > 0 };
	deps.study.upsertCourse(next);
	return next;
}

/** Change a subject's name, its topics or the "only these topics" switch. New topics become the focus of the PDFs that still had the old list. */
export function updateCourse(id: string, input: { name?: unknown; topics?: unknown; strict?: unknown }, deps: CreateDeps = defaultCreateDeps()): CreateCourse {
	const course = requireCourse(id, deps);
	let next: StudyCourse = course;
	if (input.name !== undefined && input.name !== null) {
		const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
		if (name.length === 0 || name.length > 80) throw new CreateInputError("A course needs a name of 1-80 characters", 400);
		if (deps.study.readCourses().some((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) throw new CreateInputError(`A course called "${name}" already exists`, 400);
		next = { ...next, name };
		deps.study.upsertCourse(next);
	}
	const oldTopics = course.topics ?? [];
	const topicsGiven = input.topics !== undefined && input.topics !== null;
	const strictGiven = input.strict !== undefined && input.strict !== null;
	if (topicsGiven || strictGiven) {
		next = saveTopics(next, topicsGiven ? cleanTopics(input.topics) : (next.topics ?? []), strictGiven ? input.strict === true : undefined, deps);
	}
	if (topicsGiven) inheritFocus(next, oldTopics, deps);
	return viewOf(next, jobsOf(id, deps));
}

/** Put a PDF's cards job into a subject (or, with no id, out of any): the subject's topics become its focus unless it has a focus of its own. */
export function setJobCourse(jobId: string, courseId: string | null, deps: CreateDeps = defaultCreateDeps()): CreateJobSummary {
	const found = deps.create.get(jobId);
	if (!found || found.kind !== "cards") throw new CreateInputError("Unknown job", 404);
	const course = courseId ? requireCourse(courseId, deps) : null;
	const previous = found.courseId ? deps.study.readCourses().find((c) => c.id === found.courseId) : undefined;
	const job = deps.create.update(jobId, (j) => {
		if (j.kind !== "cards") return;
		if (!course) delete j.courseId;
		else {
			if (sameList(j.settings.focusTopics, previous?.topics ?? [])) {
				j.settings.focusTopics = [...(course.topics ?? [])];
				j.settings.focusStrict = Boolean(course.strictTopics) && (course.topics ?? []).length > 0;
			}
			j.courseId = course.id;
		}
		delete j.retentionHint; // the note is about the subject: found again at the next run
	});
	if (!job) throw new CreateInputError("Unknown job", 404);
	return summarize(job);
}

// ─── Claude ──────────────────────────────────────────────────────────────────

/** The folder Claude runs in for a subject's calls (and the subject's duplicate-check progress): a job-shaped folder of its own. */
const scopeKey = (courseId: string) => `course_${courseId}`;

/** A Claude call for a subject, with a refused sign-in / limit as a 409 and a failed call as a 502. */
async function ask(courseId: string, request: { prompt: string; system: string; signal?: AbortSignal }, deps: CreateDeps): Promise<Record<string, unknown>> {
	try {
		return await askJson(deps, { ...request, cwd: deps.create.workDir(scopeKey(courseId)), model: FAST_MODEL, signal: request.signal ?? new AbortController().signal });
	} catch (err) {
		if (err instanceof RunBlocked) throw new CreateInputError(`Claude is not available: ${errorText(err)}`, 409);
		throw new CreateInputError(`Claude could not answer: ${errorText(err).slice(0, 200)}`, 502);
	}
}

// ─── the topic list from a file ──────────────────────────────────────────────

/**
 * Take a topic list from a file: .txt / .md (every line a topic) or a PDF (Claude sums up its text). A subject with no
 * topics gets them; with topics set, the file's entries are matched to them and only really new topics are added.
 */
export async function topicsFromFile(
	courseId: string,
	file: { name: string; data: Uint8Array },
	opts: { signal?: AbortSignal } = {},
	deps: CourseDeps = defaultCourseDeps(),
): Promise<TopicsFromFile> {
	const course = requireCourse(courseId, deps);
	const name = file.name.toLowerCase();
	if (!/\.(txt|md|pdf)$/.test(name)) throw new CreateInputError("Please add a text file (.txt, .md) or a PDF with the topics.", 400);

	let source: TopicsFromFile["source"] = "txt";
	let found: string[];
	if (name.endsWith(".pdf")) {
		source = "pdf";
		let text: string;
		try {
			text = await deps.uploadedPdfText(file.data, TOPICS_PDF_CHARS);
		} catch {
			throw new CreateInputError("The PDF could not be read (is it password protected?).", 400);
		}
		if (!text.trim()) throw new CreateInputError("The PDF has no readable text.", 400);
		const raw = await ask(courseId, { prompt: topicsPrompt(course.name, text), system: TOPICS_SYSTEM, signal: opts.signal }, deps);
		found = cleanTopics(raw.topics);
	} else {
		found = topicsFromText(new TextDecoder("utf-8").decode(file.data));
	}
	if (found.length === 0) throw new CreateInputError("No topics were found in the file.", 400);

	const old = course.topics ?? [];
	if (old.length === 0) {
		const saved = saveTopics(course, found, undefined, deps); // the file sets the topics (the PDFs keep their focus, like MedAnki)
		return { course: viewOf(saved, jobsOf(courseId, deps)), source, found: found.length, matched: 0, added: [...(saved.topics ?? [])] };
	}
	const raw = await ask(courseId, { prompt: matchPrompt(old, found), system: MATCH_SYSTEM, signal: opts.signal }, deps);
	const merged = mergeTopics(old, found, parseMatches(raw, old.length, found.length));
	const saved = saveTopics(course, merged.topics, undefined, deps);
	inheritFocus(saved, old, deps);
	return { course: viewOf(saved, jobsOf(courseId, deps)), source, found: found.length, matched: merged.matched, added: merged.added };
}

// ─── tidy up ─────────────────────────────────────────────────────────────────

/** A tidier topic list as a PROPOSAL: the topics set and the titles of the lecture pages, summed up into a few main topics. Nothing is saved. */
export async function proposeTopics(courseId: string, opts: { signal?: AbortSignal } = {}, deps: CreateDeps = defaultCreateDeps()): Promise<TopicProposal> {
	const course = requireCourse(courseId, deps);
	const pageTopics: string[] = [];
	const labels = new Map<string, number>();
	for (const job of jobsOf(courseId, deps)) {
		for (const result of pagesOf(job, deps)) {
			if (result.topic) pageTopics.push(`${job.name}, S. ${result.page}: ${result.topic}`);
			for (const card of result.cards) {
				if (card.deleted || !card.include) continue;
				for (const tag of card.tags) labels.set(tag, (labels.get(tag) ?? 0) + 1);
			}
		}
	}
	const current = course.topics ?? [];
	if (current.length === 0 && pageTopics.length === 0) throw new CreateInputError("This course has no topic list yet and no lectures with content.", 400);
	const common = [...labels].sort((a, b) => b[1] - a[1]).slice(0, 40);
	const raw = await ask(courseId, { prompt: consolidatePrompt(course.name, current, pageTopics, common), system: CONSOLIDATE_SYSTEM, signal: opts.signal }, deps);
	const topics = cleanProposal(raw.topics);
	if (topics.length === 0) throw new CreateInputError("Claude gave no usable proposal. Please try again.", 502);
	return { topics, current };
}

// ─── the drafts of a subject ─────────────────────────────────────────────────

function pagesOf(job: CardsJob, deps: CreateDeps): CardPageResult[] {
	return pageNumbers(job).flatMap((n) => {
		const result = deps.create.readCardPage(job.id, n);
		return result ? [result] : [];
	});
}

function draftsOf(courseId: string, deps: CreateDeps): JobDrafts[] {
	return jobsOf(courseId, deps).map((job) => ({ id: job.id, name: job.name, pages: pagesOf(job, deps) }));
}

const flat = (jobs: readonly JobDrafts[]): CourseDraft[] => jobs.flatMap((j) => j.pages.flatMap((p) => p.cards.map((card) => ({ jobId: j.id, jobName: j.name, card }))));

/** The topic labels on the subject's drafts, with how many are selected. */
export function listCourseTags(courseId: string, deps: CreateDeps = defaultCreateDeps()): CourseTag[] {
	requireCourse(courseId, deps);
	return courseTags(flat(draftsOf(courseId, deps)));
}

/** The subject's drafts that are not thrown away (all PDFs), optionally only those with one label; by PDF, then page. */
export function listCourseCards(courseId: string, tag: string | undefined, deps: CreateDeps = defaultCreateDeps()): CourseDraft[] {
	requireCourse(courseId, deps);
	return flat(draftsOf(courseId, deps))
		.filter((d) => !d.card.deleted && (tag === undefined || d.card.tags.includes(tag)))
		.sort((a, b) => a.jobName.localeCompare(b.jobName) || a.card.page - b.card.page);
}

// ─── assign the drafts to the topics ─────────────────────────────────────────

/** The runs, by subject. On globalThis for the same reason as the Create runs: Next may load this module once per route bundle. */
const live = globalThis as typeof globalThis & { __lbAssignRuns?: Map<string, AssignStatus> };
const runs = (live.__lbAssignRuns ??= new Map<string, AssignStatus>());

const keyOf = (jobId: string, cardId: string) => `${jobId}:${cardId}`;

export function assignStatus(courseId: string): AssignStatus {
	return runs.get(courseId) ?? { state: "none", done: 0, total: 0, result: null, error: "" };
}

/** Start giving every draft of the subject the topic it belongs to (replacing its labels; undoable). False if a run is going already. */
export function startAssign(courseId: string, deps: CreateDeps = defaultCreateDeps()): boolean {
	const course = requireCourse(courseId, deps);
	const topics = course.topics ?? [];
	if (topics.length === 0) throw new CreateInputError("Set the topics of the course first.", 400);
	if (assignStatus(courseId).state === "running") return false;
	const status: AssignStatus = { state: "running", done: 0, total: 0, result: null, error: "" };
	runs.set(courseId, status);
	void runAssign(courseId, topics, status, deps);
	return true;
}

async function runAssign(courseId: string, topics: readonly string[], status: AssignStatus, deps: CreateDeps): Promise<void> {
	try {
		const jobs = draftsOf(courseId, deps);
		let adopted = 0;
		const items: { key: string; text: string }[] = [];
		for (const job of jobs) {
			for (const page of job.pages) {
				for (const card of page.cards) {
					if (card.deleted) continue;
					if (card.adopted) adopted++; // a study card now: its labels are not changed here
					else items.push({ key: keyOf(job.id, card.id), text: assignCardText(card) });
				}
			}
		}
		status.total = items.length;
		const mapping = new Map<string, string>();
		for (let i = 0; i < items.length; i += ASSIGN_BATCH) {
			const batch = items.slice(i, i + ASSIGN_BATCH);
			const raw = await ask(courseId, { prompt: assignPrompt(topics, batch.map((b) => [b.key, b.text] as const)), system: ASSIGN_SYSTEM }, deps);
			for (const [key, topic] of parseAssignments(raw, topics, new Set(batch.map((b) => b.key)))) mapping.set(key, topic);
			status.done = Math.min(items.length, i + ASSIGN_BATCH);
		}

		let assigned = 0;
		let other = 0;
		let skipped = adopted;
		for (const job of jobsOf(courseId, deps)) {
			for (const result of pagesOf(job, deps)) {
				const wanted = result.cards.filter((c) => !c.deleted && !c.adopted && mapping.has(keyOf(job.id, c.id)));
				if (wanted.length === 0) continue;
				if (!pageIsFree(job, result.page)) {
					skipped += wanted.length; // being worked on right now: left as it is
					continue;
				}
				for (const card of wanted) {
					const topic = mapping.get(keyOf(job.id, card.id))!;
					card.prevTags ??= [...card.tags];
					card.tags = [topic];
					assigned++;
					if (topic === "Other") other++;
				}
				savePage(job.id, result, deps);
			}
		}
		status.result = { assigned, other, skipped };
		status.state = "done";
	} catch (err) {
		status.error = err instanceof CreateInputError ? err.message : `Assignment stopped: ${errorText(err).slice(0, 200)}`;
		status.state = "error";
	}
}

/** Give the drafts the labels they had before the assignment. Returns how many were reset. */
export function undoAssign(courseId: string, deps: CreateDeps = defaultCreateDeps()): number {
	requireCourse(courseId, deps);
	if (assignStatus(courseId).state === "running") throw new CreateInputError("The assignment is still running", 409);
	let restored = 0;
	for (const job of jobsOf(courseId, deps)) {
		for (const result of pagesOf(job, deps)) {
			const touched = result.cards.filter((c) => c.prevTags !== undefined && !c.adopted);
			if (touched.length === 0 || !pageIsFree(job, result.page)) continue;
			for (const card of touched) {
				card.tags = card.prevTags!;
				delete card.prevTags;
				restored++;
			}
			savePage(job.id, result, deps);
		}
	}
	runs.delete(courseId);
	return restored;
}

// ─── duplicates across the subject's PDFs ────────────────────────────────────

const clampThreshold = (t: number | undefined) => Math.min(1, Math.max(0.3, t ?? DEFAULT_THRESHOLD));

/** Groups of duplicate or similar drafts across all PDFs of a subject (an overview lecture and a later detail lecture show the same things), plus the ones Claude found so far. */
export function reviewCourseDuplicates(courseId: string, threshold: number | undefined, deps: CreateDeps = defaultCreateDeps()): CourseDuplicateReview {
	requireCourse(courseId, deps);
	const jobs = draftsOf(courseId, deps);
	const { pages, origin } = qualifyDrafts(jobs);
	const autoRemoved = jobs.reduce((n, j) => n + j.pages.reduce((m, p) => m + p.cards.filter((c) => c.deleted && (c.note ?? "").startsWith(DUPLICATE_NOTE)).length, 0), 0);
	const cache = deps.create.readDedupeCache(scopeKey(courseId));
	return {
		groups: findGroups(pages, clampThreshold(threshold)).map((g) => courseGroup(g, origin)),
		semantic: resolveSemanticGroups(cache.groups, pages.flatMap((p) => p.cards)).map((g) => courseGroup(g, origin)),
		autoRemoved,
	};
}

/** ONE step of Claude's content check over all PDFs of a subject (see `semanticStepOver`; its progress is kept per subject). */
export async function courseSemanticStep(courseId: string, opts: { threshold?: number; signal?: AbortSignal } = {}, deps: CreateDeps = defaultCreateDeps()): Promise<CourseSemanticStep> {
	requireCourse(courseId, deps);
	const { pages, origin } = qualifyDrafts(draftsOf(courseId, deps));
	const step = await semanticStepOver({ pages, cacheKey: scopeKey(courseId), cwd: deps.create.workDir(scopeKey(courseId)), threshold: opts.threshold, signal: opts.signal }, deps);
	return { ...step, groups: step.groups.map((g) => courseGroup(g, origin)) };
}

/**
 * Throw the other cards of duplicate groups away (soft, restorable), across PDFs; the cards are named by ref
 * ("jobId|cardId"). Same rules as one job's: study cards stay, and so does every card some group keeps.
 */
export function removeCourseDuplicates(courseId: string, groups: readonly { keep: string; remove: readonly string[] }[], deps: CreateDeps = defaultCreateDeps()): number {
	requireCourse(courseId, deps);
	const own = new Set(jobsOf(courseId, deps).map((j) => j.id));
	const names = new Map(jobsOf(courseId, deps).map((j) => [j.id, j.name]));
	const kept = new Set(groups.map((g) => g.keep));
	const removals = new Map<string, Map<string, string>>(); // job → card → the card kept
	for (const g of groups) {
		const keep = splitRef(g.keep);
		if (!keep || !own.has(keep.jobId)) continue;
		for (const ref of g.remove) {
			const at = splitRef(ref);
			if (!at || !own.has(at.jobId) || kept.has(ref)) continue;
			const label = keep.jobId === at.jobId ? keep.cardId : `${names.get(keep.jobId) ?? keep.jobId} · ${keep.cardId}`;
			removals.set(at.jobId, (removals.get(at.jobId) ?? new Map()).set(at.cardId, label));
		}
	}
	const freed = [...removals].map(([jobId, keepOf]) => ({ jobId, keepOf, pages: pagesToClear(jobId, keepOf.keys(), deps) })); // every page free before any is changed
	return freed.reduce((n, f) => n + clearCards(f.jobId, f.pages, f.keepOf, deps), 0);
}
