/**
 * Create — the pure rules (Learnbox 2.0, 2026-11): reading what the model
 * answered, checking a draft question, turning it into a study card's fields,
 * and cleaning the learner's settings. Ported from MedAnki's mcq.py /
 * cards.py; no I/O here, so the rules are tested without a model or a disk.
 */

import {
	CREATE_LANGUAGES,
	DEFAULT_MCQ_SETTINGS,
	MCQ_LETTERS,
	type CreateJob,
	type CreatePage,
	type CreatePageStatus,
	type McqLetter,
	type McqQuestion,
	type McqSettings,
} from "./contracts/create.ts";

/** JSON object out of model text: a code fence is unwrapped, then the first `{` to the last `}` is parsed.
 *  Throws when no JSON object is in there. */
export function parseModelJson(text: string): Record<string, unknown> {
	let s = (text ?? "").trim();
	const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
	if (fence) s = (fence[1] ?? "").trim();
	if (!s.startsWith("{")) {
		const a = s.indexOf("{");
		const b = s.lastIndexOf("}");
		if (a !== -1 && b > a) s = s.slice(a, b + 1);
	}
	const parsed: unknown = JSON.parse(s);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("the JSON is not an object");
	return parsed as Record<string, unknown>;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim());

export type McqDraft = Pick<McqQuestion, "question" | "options" | "correct" | "explanation">;

/**
 * The checked question, or null when it misses the minimum (it is dropped
 * quietly rather than shown broken): question, explanation and all four
 * options present; 1–3 correct letters (none, or all four, is a trivial
 * question).
 */
export function validateMcqQuestion(raw: unknown): McqDraft | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const question = text(r.question);
	const explanation = text(r.explanation);
	const optionsRaw = r.options;
	if (!question || !explanation || typeof optionsRaw !== "object" || optionsRaw === null || !Array.isArray(r.correct)) return null;

	const options = {} as Record<McqLetter, string>;
	for (const letter of MCQ_LETTERS) {
		const value = text((optionsRaw as Record<string, unknown>)[letter]);
		if (!value) return null;
		options[letter] = value;
	}
	const correct = [...new Set(r.correct.map((c) => text(c).toUpperCase()))]
		.filter((c): c is McqLetter => (MCQ_LETTERS as readonly string[]).includes(c))
		.sort();
	if (correct.length < 1 || correct.length > 3) return null;
	return { question, options, correct, explanation };
}

/** Plain model text → card HTML: escaped, **bold**, line breaks (the study screen shows card fields as HTML). */
export function cardHtml(plain: string): string {
	return plain
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>")
		.replace(/\r?\n/g, "<br>");
}

/** The study fields of an MC card (the names core/study-render.ts renders). */
export function mcqCardFields(q: McqDraft, source: string): Record<string, string> {
	return {
		Question: cardHtml(q.question),
		OptionA: cardHtml(q.options.A),
		OptionB: cardHtml(q.options.B),
		OptionC: cardHtml(q.options.C),
		OptionD: cardHtml(q.options.D),
		Correct: q.correct.join(", "),
		Explanation: cardHtml(q.explanation),
		Source: cardHtml(source),
	};
}

/** "p003-q02" → page 3; null for any other shape. */
export function pageOfQuestionId(id: string): number | null {
	const m = /^p(\d{3,})-q\d+$/.exec(id);
	return m ? Number(m[1]) : null;
}

/** The id a draft gets: `existing` drafts of the page are already numbered. */
export function questionId(page: number, index: number): string {
	return `p${String(page).padStart(3, "0")}-q${String(index).padStart(2, "0")}`;
}

/** The job's page range clamped to the PDF: 1 ≤ from ≤ to ≤ nPages (to = 0 means the end). */
export function clampPageRange(pageFrom: number, pageTo: number, nPages: number): { from: number; to: number } {
	const from = Math.min(Math.max(1, Math.trunc(pageFrom) || 1), nPages);
	const toWanted = Math.trunc(pageTo) || 0;
	const to = Math.min(nPages, toWanted > 0 ? toWanted : nPages);
	return { from, to: Math.max(from, to) };
}

export const int = (v: unknown, fallback: number, min: number, max: number): number => {
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
};

/** The request's settings over the defaults, every field checked (the body is untrusted). */
export function cleanMcqSettings(raw: unknown): McqSettings {
	const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const d = DEFAULT_MCQ_SETTINGS;
	const model = typeof r.model === "string" ? r.model.trim() : "";
	const language = (CREATE_LANGUAGES as readonly unknown[]).includes(r.language) ? (r.language as McqSettings["language"]) : d.language;
	const pageFrom = int(r.pageFrom, d.pageFrom, 1, 100_000);
	return {
		model: /^[\w.\-[\]]{2,60}$/.test(model) ? model : d.model,
		language,
		questionsPerPage: int(r.questionsPerPage, d.questionsPerPage, 1, 10),
		pageFrom,
		pageTo: int(r.pageTo, d.pageTo, 0, 100_000),
		concurrency: int(r.concurrency, d.concurrency, 1, 4),
	};
}

/** Page statuses of a job counted by status. */
export function countPages(pages: Record<string, CreatePage>): Record<CreatePageStatus, number> {
	const counts: Record<CreatePageStatus, number> = { pending: 0, running: 0, done: 0, error: 0 };
	for (const page of Object.values(pages)) counts[page.status]++;
	return counts;
}

/** The pages of a job in page order. */
export function pageNumbers(job: Pick<CreateJob, "pages">): number[] {
	return Object.keys(job.pages)
		.map(Number)
		.sort((a, b) => a - b);
}
