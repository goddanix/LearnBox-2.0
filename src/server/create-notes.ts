/**
 * Obsidian notes per topic (Learnbox 2.0, 2026-11), ported from MedAnki's topic_notes.py: one note per topic of a
 * course, written from the cards of that topic and the pages they stand on across all PDFs of the course, kept as a
 * note set (reviewable, editable, rewritable per topic) and saved into the Obsidian vault on request. The rules are
 * core/topic-notes.ts, core/vault-text.ts and the prompts agent/create/notes-prompts.ts; the files of the vault are
 * store/vault.ts; here: the runs, Claude, the PDFs, and the glue.
 *
 * Not ported: the notes per PDF, the automatic chain after a PDF is done (saving into the vault is a click), the
 * local model, and the calendar courses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { HEADING_SYSTEM, headingPrompt, TOPIC_SYSTEM, topicPrompt, TRIM_SYSTEM, trimPrompt } from "../agent/create/notes-prompts.ts";
import { rasterToPng } from "../agent/layout/render.ts";
import { assignCardText } from "../core/course-topics.ts";
import { type CardsJob, CreateInputError, type StudyCourse } from "../core/contracts.ts";
import type { CardDraft } from "../core/contracts/create-cards.ts";
import type { NoteSource, NotesDoc, NotesRun, NotesView, SavedNotes, TopicNote } from "../core/contracts/create-notes.ts";
import type { PageLayout } from "../core/contracts/page-layout.ts";
import { pageNumbers } from "../core/create.ts";
import {
	cardsByTopic,
	CARDS_MAX,
	countWords,
	FIG_CANDIDATES,
	figureCandidates,
	HEADING_BATCH,
	linkRefs,
	MAX_PAGES,
	PAGE_WORDS,
	pageText,
	parseHeadingAssignments,
	sourcePages,
	stub,
	tidy,
	TOPIC_FIGS,
	toObsidianTopic,
	TRIM_FACTOR,
	trimWords,
	WORKERS,
	wordBudget,
} from "../core/topic-notes.ts";
import { byCodePoint, obsidianUrl, safeName, slug } from "../core/vault-text.ts";
import { notesStore, type NotesStore, emptyNotesDoc } from "../store/notes.ts";
import { saveTopicNotes } from "../store/vault.ts";
import { vaultSettings, type VaultSettings } from "../store/vault-settings.ts";
import { type CardsDeps, defaultCardsDeps, FAST_MODEL } from "./create-cards.ts";
import { askJson, errorText, pool, RunBlocked } from "./create-shared.ts";

/** The model that writes a topic note (a judgement about what matters); the small chores run on FAST_MODEL. */
export const NOTES_MODEL = "sonnet";
/** A cut-out figure: this many pixels on its long side (MedAnki's setting). */
const FIGURE_PX = 1400;

/** What the notes need on top of a cards run's collaborators. */
export interface NotesDeps extends CardsDeps {
	notes: NotesStore;
	vault: VaultSettings;
	/** Parts of a PDF's pages (normalised boxes) as PNG pictures. */
	cutFigures: (pdfPath: string, cuts: readonly { page: number; bbox: readonly number[] }[]) => Promise<Uint8Array[]>;
}

export const defaultNotesDeps = (): NotesDeps => {
	const base = defaultCardsDeps();
	return {
		...base,
		notes: notesStore,
		vault: vaultSettings,
		cutFigures: async (pdfPath, cuts) => {
			const session = await base.openPdf(pdfPath);
			try {
				const out: Uint8Array[] = [];
				for (const cut of cuts) out.push(await rasterToPng(await session.renderRegion(cut.page, cut.bbox, FIGURE_PX)));
				return out;
			} finally {
				await session.close();
			}
		},
	};
};

const pad2 = (n: number) => String(n).padStart(2, "0");
/** The local calendar date "YYYY-MM-DD". */
export const localDate = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// ─── the course and its material ─────────────────────────────────────────────

function requireCourse(id: string, deps: Pick<NotesDeps, "study">): StudyCourse {
	const course = deps.study.readCourses().find((c) => c.id === id);
	if (!course) throw new CreateInputError("Unknown course", 404);
	return course;
}

/** The cards jobs of a course, oldest first (D1, D2 … follow this order). */
function jobsOf(courseId: string, deps: Pick<NotesDeps, "create">): CardsJob[] {
	return deps.create
		.list()
		.filter((j): j is CardsJob => j.kind === "cards" && j.courseId === courseId)
		.sort((a, b) => byCodePoint(a.createdAt, b.createdAt) || byCodePoint(a.id, b.id)); // the time is only to the second: the id fixes the order
}

/** The PDFs of the course with their short names D1, D2 … and a file name that is unique in the vault. */
function noteSources(jobs: readonly CardsJob[]): NoteSource[] {
	const names = new Set<string>();
	return jobs.map((job, i) => {
		const base = safeName(job.name, "Dokument");
		let name = `${base}.pdf`;
		for (let n = 2; names.has(name); n++) name = `${base} (${n}).pdf`;
		names.add(name);
		return { ref: `D${i + 1}`, jobId: job.id, name: job.name.replace(/^\d+\.\s+/, ""), pdfFile: name }; // a lecture's "5. Title": the label of a link has no number (MedAnki's file stems had no dot)
	});
}

interface CourseCard {
	jobId: string;
	page: number;
	card: CardDraft;
}

/** Every draft of the course with where it stands. */
function courseCards(jobs: readonly CardsJob[], deps: Pick<NotesDeps, "create">): CourseCard[] {
	return jobs.flatMap((job) =>
		pageNumbers(job).flatMap((page) => {
			const result = deps.create.readCardPage(job.id, page);
			return result ? result.cards.map((card) => ({ jobId: job.id, page, card })) : [];
		}),
	);
}

const scopeKey = (courseId: string) => `course_${courseId}`;

/** A Claude call for the course's chores (the page headings). */
const askFast = (courseId: string, request: { prompt: string; system: string }, deps: NotesDeps): Promise<Record<string, unknown>> =>
	askJson(deps, { ...request, cwd: deps.create.workDir(scopeKey(courseId)), model: FAST_MODEL, signal: new AbortController().signal });

/** For topics with no card of their own: their pages by the heading of each page (the topic's name against the headings). Topic → [(job, page)]. */
async function pagesByHeading(courseId: string, topics: readonly string[], jobs: readonly CardsJob[], deps: NotesDeps): Promise<Map<string, { jobId: string; page: number }[]>> {
	const out = new Map<string, { jobId: string; page: number }[]>();
	if (topics.length === 0) return out;
	const items: [string, number, string][] = [];
	for (const job of jobs) {
		for (const page of pageNumbers(job)) {
			const heading = (job.headings?.[String(page)] ?? "").trim();
			if (heading) items.push([job.id, page, heading]);
		}
	}
	for (let i = 0; i < items.length; i += HEADING_BATCH) {
		const batch = items.slice(i, i + HEADING_BATCH);
		const keys = new Set(batch.map(([jobId, page]) => `${jobId}:${page}`));
		const raw = await askFast(courseId, { prompt: headingPrompt(topics, batch), system: HEADING_SYSTEM }, deps);
		for (const [topic, pages] of parseHeadingAssignments(raw, keys, topics)) out.set(topic, [...(out.get(topic) ?? []), ...pages]);
	}
	return out;
}

// ─── the runs ────────────────────────────────────────────────────────────────

/** The runs, by course. On globalThis for the same reason as the Create runs: Next may load this module once per route bundle. */
const live = globalThis as typeof globalThis & { __lbNotesRuns?: Map<string, NotesRun> };
const runs = (live.__lbNotesRuns ??= new Map<string, NotesRun>());

const INTERRUPTED = "The run was interrupted — please write the notes again.";

/** The stored note set, but with a run that no longer exists reported honestly. */
function readDoc(courseId: string, deps: Pick<NotesDeps, "notes">): NotesDoc {
	const doc = deps.notes.read(courseId) ?? emptyNotesDoc();
	if (doc.status !== "running" || runs.has(courseId)) return doc;
	return deps.notes.update(courseId, (d) => {
		for (const it of d.items) if (it.kind === "pending") [it.kind, it.error] = ["error", "not written (interrupted)"];
		d.status = "error";
		d.error = INTERRUPTED;
	});
}

/** The note set of a course, with the progress of a run that is going on. */
export function getNotes(courseId: string, deps: NotesDeps = defaultNotesDeps()): NotesView {
	requireCourse(courseId, deps);
	return { ...readDoc(courseId, deps), run: runs.get(courseId) ?? null };
}

/** The layout of a page: the one kept from the card run, else read from the PDF (and not kept: the card run would take a lighter one for its own). */
async function layoutFor(job: CardsJob, page: number, deps: NotesDeps): Promise<PageLayout> {
	const cached = deps.create.readLayout(job.id, page);
	if (cached) return cached;
	const pdf = deps.library.pdfPath(job.lectureId);
	if (!pdf) throw new Error(`The PDF "${job.name}" is no longer in the library.`);
	const layout = (await deps.layouts(pdf, [page], { ocr: false, legends: false })).get(page);
	if (!layout) throw new Error(`Page ${page} of "${job.name}" could not be read.`);
	return layout;
}

interface FigureCandidate {
	id: string;
	ref: string;
	src: string;
	page: number;
	caption: string;
	area: number;
}

const text = (v: unknown): string => (v === null || v === undefined || v === "" || v === 0 || v === false ? "" : String(v));
const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/** One topic note, written by Claude from the topic's cards and pages. → the finished item (kind note, or skipped) */
async function makeTopic(
	courseId: string,
	course: StudyCourse,
	item: TopicNote,
	cards: readonly CourseCard[],
	jobs: readonly CardsJob[],
	srcs: readonly NoteSource[],
	headingPages: readonly { jobId: string; page: number }[],
	deps: NotesDeps,
): Promise<TopicNote> {
	const order = new Map(srcs.map((s, i) => [s.jobId, i]));
	const own = cards.filter((c) => order.has(c.jobId));
	const fallback = headingPages.filter((p) => order.has(p.jobId));
	if (own.length === 0 && fallback.length === 0) return { ...item, kind: "skipped", skipReason: stub(item.ix, item.topic, 0).skipReason };

	const refs = Object.fromEntries(srcs.map((s) => [s.ref, s]));
	const jobById = new Map(jobs.map((j) => [j.id, j]));
	const keys =
		own.length > 0
			? sourcePages(own, order)
			: [...new Map(fallback.map((p) => [`${p.jobId}|${p.page}`, p])).values()].slice(0, MAX_PAGES).sort((a, b) => order.get(a.jobId)! - order.get(b.jobId)! || a.page - b.page);

	const pages: { ref: string; jobId: string; page: number; layout: PageLayout; text: string }[] = [];
	for (const { jobId, page } of keys) {
		const layout = await layoutFor(jobById.get(jobId)!, page, deps);
		pages.push({ ref: srcs[order.get(jobId)!]!.ref, jobId, page, layout, text: trimWords(pageText(layout), PAGE_WORDS) });
	}
	const nWords = wordBudget(pages.reduce((n, p) => n + words(p.text), 0));

	// the figures of these pages that suit a note, cut out of the PDFs
	const figsDir = deps.notes.figsDir(courseId);
	let cands: FigureCandidate[] = [];
	for (const s of srcs) {
		const ps = pages.filter((p) => p.jobId === s.jobId);
		const pdf = deps.library.pdfPath(jobById.get(s.jobId)!.lectureId);
		if (ps.length === 0 || !pdf) continue;
		const found = figureCandidates(ps.map((p) => ({ page: p.page, layout: p.layout })), TOPIC_FIGS);
		if (found.length === 0) continue;
		let pngs: Uint8Array[];
		try {
			pngs = await deps.cutFigures(pdf, found.map((c) => ({ page: c.page, bbox: c.bbox })));
		} catch {
			continue; // a note without its figures is still a note
		}
		found.forEach((c, i) => {
			const name = `${s.ref}_${c.id}.png`;
			fs.writeFileSync(path.join(figsDir, name), pngs[i]!);
			cands.push({ id: `${s.ref}_${c.id}`, ref: s.ref, src: `figs/${name}`, page: c.page, caption: c.caption, area: c.area });
		});
	}
	cands = cands
		.sort((a, b) => Number(Boolean(b.caption)) - Number(Boolean(a.caption)) || b.area - a.area)
		.slice(0, FIG_CANDIDATES)
		.sort((a, b) => byCodePoint(a.ref, b.ref) || a.page - b.page || byCodePoint(a.id, b.id));
	const nFig = Math.min(TOPIC_FIGS, cands.length);

	const cardLines = own.slice(0, CARDS_MAX).map((c) => assignCardText(c.card));
	const material = pages
		.filter((p) => p.text.trim())
		.map((p) => `=== ${p.ref} · S. ${p.page} ===\n${p.text}`)
		.join("\n\n");
	const cwd = path.dirname(figsDir); // the Read tool may open only what lies below: the figures are under figs/
	const signal = new AbortController().signal;
	const raw = await askJson(deps, { prompt: topicPrompt(course.name, item.topic, cardLines, material, cands, nWords, nFig), system: TOPIC_SYSTEM, cwd, model: NOTES_MODEL, signal });
	let markdown = text(raw.markdown).trim();
	if (!markdown) throw new Error("Claude gave no note.");
	if (countWords(markdown) > nWords * TRIM_FACTOR) {
		try {
			// cutting to a word limit and keeping the structure is a chore for the small model
			markdown = text((await askJson(deps, { prompt: trimPrompt(nWords, markdown), system: TRIM_SYSTEM, cwd, model: FAST_MODEL, signal })).markdown).trim() || markdown;
		} catch (err) {
			if (err instanceof RunBlocked) throw err; // a lost sign-in stops the run; a failed shortening leaves the note as it is
		}
	}
	const { markdown: body, used } = toObsidianTopic(markdown, { topic: item.topic, refs, cands, maxFigs: nFig });
	const tags = (Array.isArray(raw.tags) ? raw.tags : [])
		.filter((t) => text(t).trim())
		.map((t) => slug(text(t)).toLowerCase())
		.slice(0, 3);
	return { ...item, kind: "note", tags, markdown: body, words: countWords(body), figures: used, refs: [...new Set(pages.map((p) => p.ref))].sort(byCodePoint), pages: pages.length, error: "" };
}

const NOT_AVAILABLE = (why: string) => `Claude is not available: ${why}`;

/** Write the topic notes of a course (all, or only the one item `only`). Never throws: the outcome is in the stored note set. */
async function runNotes(courseId: string, only: string | null, deps: NotesDeps): Promise<void> {
	const run = runs.get(courseId)!;
	try {
		const course = requireCourse(courseId, deps);
		const topics = course.topics ?? [];
		if (topics.length === 0) throw new CreateInputError("Set the topics of the course first.", 400);
		const jobs = jobsOf(courseId, deps);
		const byTopic = cardsByTopic(courseCards(jobs, deps), new Set(topics));
		let srcs: NoteSource[];
		let byHeading: Map<string, { jobId: string; page: number }[]>;
		let items: TopicNote[];
		if (only === null) {
			srcs = noteSources(jobs);
			const cardless = topics.filter((t) => !byTopic.get(t)?.length);
			byHeading = cardless.length > 0 ? await pagesByHeading(courseId, cardless, jobs, deps) : new Map();
			items = topics.map((t, i) => stub(i + 1, t, byTopic.get(t)?.length ?? 0, byHeading.get(t)?.length ?? 0));
			deps.notes.update(courseId, (d) => Object.assign(d, { status: "running", error: "", name: course.name, created: localDate(deps.now()), sources: srcs, items }));
		} else {
			const doc = deps.notes.read(courseId);
			const it = doc?.items.find((x) => x.id === only);
			if (!doc || !it) throw new CreateInputError("Unknown topic", 404);
			srcs = doc.sources;
			byHeading = byTopic.get(it.topic)?.length ? new Map() : await pagesByHeading(courseId, [it.topic], jobs, deps);
			items = [{ ...it, kind: "pending", error: "" }];
			deps.notes.update(courseId, (d) => Object.assign(d, { status: "running", error: "" }));
		}
		const todo = items.filter((it) => it.kind === "pending");
		Object.assign(run, { stage: "Writing the topic notes", done: 0, total: todo.length });

		let blocked: string | null = null;
		await pool(todo, WORKERS, async (it) => {
			if (blocked !== null) return;
			let res: TopicNote;
			try {
				res = await makeTopic(courseId, course, it, byTopic.get(it.topic) ?? [], jobs, srcs, byHeading.get(it.topic) ?? [], deps);
			} catch (err) {
				if (err instanceof RunBlocked) {
					blocked = err.message;
					return;
				}
				res = { ...it, kind: "error", error: errorText(err).slice(0, 200) || "Error" }; // one failed note does not stop the others
			}
			deps.notes.update(courseId, (d) => {
				const at = d.items.findIndex((x) => x.id === res.id);
				if (at >= 0) d.items[at] = res;
			});
			run.done++;
		});
		deps.notes.update(courseId, (d) => {
			for (const it of d.items) if (it.kind === "pending") [it.kind, it.error] = ["error", blocked === null ? "not written" : "not written (Claude not available)"];
			d.status = blocked === null ? "done" : "error";
			d.error = blocked === null ? "" : NOT_AVAILABLE(blocked);
		});
	} catch (err) {
		const message = err instanceof CreateInputError ? err.message : `The topic notes could not be written: ${errorText(err).slice(0, 300)}`;
		deps.notes.update(courseId, (d) => Object.assign(d, { status: "error", error: message }));
	} finally {
		runs.delete(courseId);
	}
}

function launch(courseId: string, only: string | null, deps: NotesDeps): boolean {
	if (runs.has(courseId)) return false;
	runs.set(courseId, { stage: "Starting", done: 0, total: 0 });
	void runNotes(courseId, only, deps);
	return true;
}

/** Write (again) all topic notes of the course. Needs topics and cards assigned to them. False if a run is going already. */
export function startNotes(courseId: string, deps: NotesDeps = defaultNotesDeps()): boolean {
	const course = requireCourse(courseId, deps);
	const topics = course.topics ?? [];
	if (topics.length === 0) throw new CreateInputError("Set the topics of the course first.", 400);
	if (cardsByTopic(courseCards(jobsOf(courseId, deps), deps), new Set(topics)).size === 0) {
		throw new CreateInputError('No selected card is assigned to a topic yet — use "Sort the drafts into the topics" first.', 400);
	}
	return launch(courseId, null, deps);
}

/** Write one topic's note again (from the sources the note set was made from). False if a run is going already. */
export function rewriteTopic(courseId: string, itemId: string, deps: NotesDeps = defaultNotesDeps()): boolean {
	requireCourse(courseId, deps);
	const doc = readDoc(courseId, deps);
	if (!doc.items.some((it) => it.id === itemId)) throw new CreateInputError("Unknown topic", 404);
	if (doc.sources.length === 0) throw new CreateInputError("This note set has no sources — please write all topic notes again.", 400);
	return launch(courseId, itemId, deps);
}

// ─── editing a note ──────────────────────────────────────────────────────────

/** Change a written note's text, or whether it goes into the vault. */
export function updateNote(courseId: string, itemId: string, input: { markdown?: unknown; include?: unknown }, deps: NotesDeps = defaultNotesDeps()): TopicNote {
	requireCourse(courseId, deps);
	const doc = readDoc(courseId, deps);
	const found = doc.items.find((it) => it.id === itemId);
	if (!found) throw new CreateInputError("Unknown topic", 404);
	if (found.kind !== "note") throw new CreateInputError("This topic note has not been written yet.", 400);
	if (input.markdown !== undefined && typeof input.markdown !== "string") throw new CreateInputError("The text of a note must be text", 400);
	if (input.include !== undefined && typeof input.include !== "boolean") throw new CreateInputError("`include` must be true or false", 400);
	const next = deps.notes.update(courseId, (d) => {
		const it = d.items.find((x) => x.id === itemId)!;
		if (typeof input.markdown === "string") {
			it.markdown = `${input.markdown.replace(/\r\n/g, "\n").trim()}\n`;
			it.words = countWords(it.markdown);
		}
		if (typeof input.include === "boolean") it.include = input.include;
	});
	return next.items.find((x) => x.id === itemId)!;
}

/** A figure of the note set for the preview (found by its file name in the vault, never by a free path). */
export function noteFigureFile(courseId: string, name: string, deps: NotesDeps = defaultNotesDeps()): { file: string; type: string } {
	requireCourse(courseId, deps);
	const figure = readDoc(courseId, deps)
		.items.flatMap((it) => it.figures)
		.find((f) => f.file === name);
	const file = figure ? path.join(path.dirname(deps.notes.figsDir(courseId)), figure.src) : "";
	if (!figure || !fs.existsSync(file)) throw new CreateInputError("Unknown picture", 404);
	return { file, type: "image/png" };
}

// ─── into the vault ──────────────────────────────────────────────────────────

/** Write the selected notes into the Obsidian vault: `<course>/Themen/<topic>.md` each, the overview, the PDFs and the figures. The reader's own part of a note stays. */
export function saveToVault(courseId: string, deps: NotesDeps = defaultNotesDeps()): SavedNotes {
	const course = requireCourse(courseId, deps);
	const doc = readDoc(courseId, deps);
	if (doc.status !== "done") throw new CreateInputError("There are no finished topic notes yet.", 400);
	const chosen = doc.items.filter((it) => it.kind === "note" && it.include && it.markdown.trim());
	if (chosen.length === 0) throw new CreateInputError("No topic note is selected for saving.", 400);
	const target = deps.vault.location().path;
	const srcs = new Map(doc.sources.map((s) => [s.ref, s]));
	const refs = Object.fromEntries(srcs);
	const usedRefs = [...new Set(chosen.flatMap((it) => it.refs))].sort(byCodePoint).filter((r) => srcs.has(r));
	const pdfs = usedRefs.map((r) => {
		const s = srcs.get(r)!;
		const job = deps.create.get(s.jobId);
		const file = job && job.kind === "cards" ? deps.library.pdfPath(job.lectureId) : null;
		if (!file) throw new CreateInputError(`The PDF "${s.name}" is no longer in the library — the notes cannot link to it.`, 409);
		return { src: file, name: s.pdfFile };
	});
	const courseDir = path.dirname(deps.notes.figsDir(courseId));
	const figs: { src: string; name: string }[] = [];
	for (const it of chosen) {
		const referenced = new Set([...it.markdown.matchAll(/!\[\[([^\]|]+)/g)].map((m) => m[1]!));
		for (const f of it.figures) {
			const src = path.join(courseDir, f.src);
			if (referenced.has(f.file) && fs.existsSync(src)) figs.push({ src, name: f.file });
		}
	}
	const key = course.vaultKey?.trim() || course.id;
	const topics = chosen.map((it) => ({
		mid: `${key}-${slug(it.topic, 60)}`,
		title: it.topic,
		markdown: tidy(linkRefs(it.markdown, refs)),
		cards: it.cards,
		tags: [...new Set(["medizinstudium", slug(course.name).toLowerCase(), ...(it.tags ?? [])])].slice(0, 6),
	}));
	let res: ReturnType<typeof saveTopicNotes>;
	try {
		res = saveTopicNotes(target, { subject: course.name, courseId: key, topics, pdfs, figs, pdfSources: usedRefs.map((r) => srcs.get(r)!.pdfFile), created: doc.created || localDate(deps.now()) });
	} catch (err) {
		throw new CreateInputError(`Could not write into the vault (${target}): ${errorText(err)}`, 409);
	}
	const saved: SavedNotes = {
		path: res.moc,
		url: obsidianUrl(res.moc),
		created: res.mocCreated,
		vault: target,
		count: res.notes.length,
		...(res.notes.some((n) => n.skipped) ? { skipped: res.notes.filter((n) => n.skipped).length } : {}),
		at: localDate(deps.now()),
	};
	deps.notes.update(courseId, (d) => {
		d.saved = saved;
	});
	return saved;
}
