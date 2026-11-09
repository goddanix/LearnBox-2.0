import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { LectureOutline, LectureTopic } from "../../core/contracts.ts";
import type { PiEngine } from "../models.ts";
import { pdfExtract, pdfInfo } from "./pdf-ops.ts";
import { runSubmitAgent } from "./submit-agent.ts";

/**
 * The lecture outliner (Learnbox, 2026-10): turns one lecture PDF into a topic
 * structure — title, a one-line summary and a page range per topic — so the
 * prober and the plan can aim at topics the learner picks, at the depth they
 * pick. It reads the extracted TEXT only (slides and scripts are text); pages
 * with almost no text are reported as thin, never guessed at.
 *
 * Shape: the PDF's pages are packed into windows of bounded size; each window
 * is ONE schema-validated submit (runSubmitAgent) that sees the topics found
 * so far, so a topic spanning a window boundary is continued, not duplicated.
 * The submit is validated against the pipeline's laws (page range inside the
 * window, every content page covered) and the model retries on a violation.
 * Everything after the submits — merging continuations, ordering, ids — is
 * deterministic.
 */

/** Characters of page text per window (≈ 7k tokens): small enough that the
 *  model reads every page, large enough that a lecture is a handful of calls. */
const WINDOW_CHARS = 24_000;
/** One page's text is clipped here in the prompt (a dense script page). */
const PAGE_CHARS = 6_000;
/** A page with fewer extracted characters than this has no content to outline. */
const THIN_PAGE_CHARS = 40;
/** How many earlier topics ride along as context for continuation. */
const DIGEST_TOPICS = 40;

const INSTRUCTIONS = `You structure lecture material into topics for a study planner. The learner will pick
topics from your outline and choose how deep to study each one, so the outline must let them
judge a topic from its title and summary alone.

A topic is one coherent idea a learner can be taught and tested on: typically 2-8 slides, or 1-3
dense script pages. It is not a chapter, and not a single slide unless that slide stands alone
(a derivation, a key experiment). Prefer topics that name a mechanism, law, method or structure
over topics that name a heading.

For each topic give:
- title: a concise noun phrase naming the concept.
- summary: one or two sentences saying what the lecture claims, derives or shows about it,
  naming the key quantities, equations or experiments in words. This is how the planner judges
  depth, so be specific. Never pad.
- pageStart / pageEnd: the pages it spans (1-based, inclusive, inside the pages you were shown).

Rules:
- Write titles and summaries in the language of the lecture pages, whatever language the learner or the rest of the application uses. Do not translate: keep the lecture's own terms, symbols and notation. A submit in another language is rejected.
- Use only what the pages say. Do not add content from your own knowledge, and do not invent
  topics for pages you were not shown.
- Skip title pages, agendas, reference lists, thank-you and question slides.
- Cover every page that has real content; topics are in page order and do not overlap.
- If the first topic of your window continues the last topic already found (see "Topics so far"),
  set continuesPrevious to true on it and give the pages it adds. Otherwise leave it out.

Submit the whole window once with submit_topics.`;

const TopicsSchema = Type.Object({
	topics: Type.Array(
		Type.Object({
			title: Type.String({ minLength: 1 }),
			summary: Type.String({ minLength: 1 }),
			pageStart: Type.Integer({ minimum: 1 }),
			pageEnd: Type.Integer({ minimum: 1 }),
			continuesPrevious: Type.Optional(Type.Boolean()),
		}),
		{ minItems: 1 },
	),
});

interface SubmittedTopic {
	title: string;
	summary: string;
	pageStart: number;
	pageEnd: number;
	continuesPrevious?: boolean;
}

// ─── Language of the slides ─────────────────────────────────────────────────
//
// The outline must be written in the language of the pages: the learner meets
// these titles next to the slides, and a German title over English slides
// misleads every later lookup. A prompt rule alone is not enough (the model
// followed the learner's language instead), so the pipeline checks it: the
// pages' language is detected from function words, handed to the model by name,
// and a submit detectably in another language is rejected like any other
// broken law. Detection refuses to guess — too little text, or two languages
// close together, gives null, and a null on either side enforces nothing.

const FUNCTION_WORDS = {
	English: "the and of is are that with for which this from by as be at it was were has have not or can its their these when than into between",
	German: "der die das und ist nicht mit von zu den dem ein eine für auf im sich auch als wird bei werden oder wie nach aus über sind dass zum zur einer eines durch",
	French: "le la les des est une et pour dans que qui sur par avec au du ne pas sont ce se plus aux ses cette entre comme",
	Spanish: "el los las es una para con por que del se como más son al lo sus esta entre este pero sin sobre también",
	Italian: "il lo gli di che è per con una della sono non come delle degli nel più anche questo tra sul dei alla",
	Portuguese: "os as uma para com não do da em são dos das mais como pelo pela entre também este seu sua ou ao",
} as const;
export type SlideLanguage = keyof typeof FUNCTION_WORDS;
const WORD_SETS = Object.entries(FUNCTION_WORDS).map(([language, words]) => [language as SlideLanguage, new Set(words.split(" "))] as const);

/** The language of a text by function-word share, or null when unclear. */
export function detectLanguage(text: string): SlideLanguage | null {
	const tokens = text.toLowerCase().match(/\p{L}+/gu) ?? [];
	// A summary is one or two sentences, so the floor is low; the hit count and
	// the margin below are what keep a short text from being guessed at.
	if (tokens.length < 12) return null;
	const hits = WORD_SETS.map(([language, words]) => [language, tokens.filter((t) => words.has(t)).length] as const).sort((a, b) => b[1] - a[1]);
	const [best, runnerUp] = hits;
	// At least three function words, one in ten tokens, and clearly ahead of the next language.
	if (!best || !runnerUp || best[1] < 3 || best[1] < tokens.length / 10 || best[1] < runnerUp[1] * 1.5) return null;
	return best[0];
}

export interface LectureOutlineOptions {
	engine?: PiEngine;
	abortSignal?: AbortSignal;
	/** Money channel: one call per model request. */
	onUsage?: (usage: Usage) => void;
	/** Windows finished so far, out of the total. */
	onProgress?: (done: number, total: number) => void;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
}

/** "--- Page N ---" headed extraction → page number → text. */
export function splitPages(extracted: string): Map<number, string> {
	const pages = new Map<number, string>();
	const parts = extracted.split(/^--- Page (\d+) ---$/m);
	// split() with a capture group: [preamble, "1", text1, "2", text2, ...]
	for (let i = 1; i < parts.length; i += 2) pages.set(Number(parts[i]), (parts[i + 1] ?? "").trim());
	return pages;
}

/** Consecutive pages packed into windows of at most WINDOW_CHARS (≥ 1 page each). */
export function windowPages(texts: Map<number, string>, pageCount: number): Array<{ start: number; end: number }> {
	const windows: Array<{ start: number; end: number }> = [];
	let start = 1;
	let size = 0;
	for (let page = 1; page <= pageCount; page++) {
		const len = Math.min(texts.get(page)?.length ?? 0, PAGE_CHARS);
		if (page > start && size + len > WINDOW_CHARS) {
			windows.push({ start, end: page - 1 });
			start = page;
			size = 0;
		}
		size += len;
	}
	windows.push({ start, end: pageCount });
	return windows;
}

/** The pipeline laws a submitted window must satisfy ("" = accept). */
export function windowProblem(
	topics: SubmittedTopic[],
	window: { start: number; end: number },
	contentPages: Set<number>,
	language: SlideLanguage | null = null,
): string | null {
	const written = language ? detectLanguage(topics.map((t) => `${t.title}. ${t.summary}`).join(" ")) : null;
	if (language && written && written !== language) {
		return `Titles and summaries must be written in ${language}, the language of the lecture pages, but this submit is in ${written}. Rewrite them in ${language}; do not translate the lecture's terms.`;
	}
	const covered = new Set<number>();
	let lastEnd = window.start - 1;
	for (const t of topics) {
		if (t.pageStart > t.pageEnd) return `"${t.title}" has pageStart ${t.pageStart} after pageEnd ${t.pageEnd}.`;
		if (t.pageStart < window.start || t.pageEnd > window.end) {
			return `"${t.title}" spans pages ${t.pageStart}-${t.pageEnd}, outside the pages shown (${window.start}-${window.end}).`;
		}
		if (t.pageStart <= lastEnd) return `"${t.title}" overlaps the topic before it; topics must be in page order without overlap.`;
		lastEnd = t.pageEnd;
		for (let p = t.pageStart; p <= t.pageEnd; p++) covered.add(p);
	}
	const missing = [...contentPages].filter((p) => p >= window.start && p <= window.end && !covered.has(p));
	if (missing.length > 0) {
		return `Pages with content are not covered by any topic: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", …" : ""}. Extend a topic or add one; only title, agenda, reference and thank-you pages may stay out.`;
	}
	return null;
}

/** Fold the window's topics into the running list: continuations extend the previous topic. */
export function mergeWindow(acc: LectureTopic[], submitted: SubmittedTopic[]): void {
	for (const [i, t] of submitted.entries()) {
		const prev = acc[acc.length - 1];
		if (i === 0 && t.continuesPrevious && prev) {
			prev.pageEnd = Math.max(prev.pageEnd, t.pageEnd);
			continue;
		}
		acc.push({ id: "", title: t.title.trim(), summary: t.summary.trim(), pageStart: t.pageStart, pageEnd: t.pageEnd });
	}
}

export async function buildLectureOutline(pdfPath: string, opts: LectureOutlineOptions = {}): Promise<LectureOutline> {
	const info = await pdfInfo(pdfPath);
	const texts = splitPages(await pdfExtract(pdfPath, "all"));
	const contentPages = new Set(info.pages.filter((p) => p.text_length >= THIN_PAGE_CHARS).map((p) => p.page));
	const thinPages = info.pages.filter((p) => p.text_length < THIN_PAGE_CHARS).map((p) => p.page);
	if (contentPages.size === 0) {
		throw new Error(
			"The PDF has no extractable text (scanned or image-only slides). The outliner reads text; reading images is not supported yet.",
		);
	}

	// The lecture's language, from all of its text (null when unclear).
	const language = detectLanguage([...texts.values()].join(" ").slice(0, 60_000));
	const windows = windowPages(texts, info.page_count);
	const topics: LectureTopic[] = [];
	opts.onProgress?.(0, windows.length);
	for (const [index, window] of windows.entries()) {
		const pageBlocks: string[] = [];
		for (let p = window.start; p <= window.end; p++) {
			const text = (texts.get(p) ?? "").slice(0, PAGE_CHARS);
			pageBlocks.push(`--- Page ${p} ---\n${text || "(no text)"}`);
		}
		const digest = topics
			.slice(-DIGEST_TOPICS)
			.map((t) => `- ${t.title} (pp. ${t.pageStart}-${t.pageEnd})`)
			.join("\n");
		const prompt = [
			`Lecture file: ${info.page_count} pages in total. You are shown pages ${window.start}-${window.end}.`,
			language
				? `Language of the lecture: ${language}. Write every title and summary in ${language}.`
				: "Write every title and summary in the language of the pages below.",
			"",
			"Topics so far:",
			digest || "(none yet)",
			"",
			...pageBlocks,
		].join("\n");

		let submitted: SubmittedTopic[] | undefined;
		await runSubmitAgent<{ topics: SubmittedTopic[] }>({
			role: "pdfReader",
			toolName: "submit_topics",
			toolDescription: "Submit the topics of the pages shown, once, in page order.",
			parameters: TopicsSchema,
			fill: (input) => ({ topics: input.topics as SubmittedTopic[] }),
			systemPrompt: INSTRUCTIONS,
			prompt,
			engine: opts.engine,
			signal: opts.abortSignal,
			chatId: opts.chatId,
			neverSubmitted: `The outliner never submitted topics for pages ${window.start}-${window.end}.`,
			onStep: (usage) => opts.onUsage?.(usage),
			validate: (value) => windowProblem(value.topics, window, contentPages, language),
		}).then((value) => {
			submitted = value.topics;
		});
		mergeWindow(topics, submitted ?? []);
		opts.onProgress?.(index + 1, windows.length);
	}

	topics.sort((a, b) => a.pageStart - b.pageStart);
	topics.forEach((t, i) => {
		t.id = `t${i + 1}`;
	});
	return { topics, generatedAt: new Date().toISOString(), ...(thinPages.length > 0 ? { thinPages } : {}) };
}
