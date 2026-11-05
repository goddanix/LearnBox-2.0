/**
 * Cards from a lesson — the pure rules (Learnbox 2.0, 2026-11, Slice 9c): which statements a lesson
 * (or a graph pick) offers, reading what the model answered for one statement into draft cards,
 * editing a draft, and turning a draft into study cards. The drafts live next to the other Create
 * drafts (server/create-lesson.ts); a study card made from one is ALWAYS core knowledge and carries
 * the graph origin (statement, job, draft), so the cards of one draft are siblings.
 */

import { cardId } from "./card-normalize.ts";
import { CardEditError } from "./card-edit.ts";
import { fmt, studyCardId, tagPart } from "./card-adopt.ts";
import { CLOZE_RE, cleanText, clozeOk, norm } from "./card-util.ts";
import { CREATE_LANGUAGES } from "./contracts/create.ts";
import type { GraphSnapshot } from "./contracts/graph.ts";
import {
	DEFAULT_LESSON_SETTINGS,
	LESSON_CARDS_PER_STATEMENT,
	type LessonDraft,
	type LessonSettings,
	type LessonStatement,
	type LessonStatementOption,
} from "./contracts/create-lesson.ts";
import type { StudyCard } from "./contracts/study.ts";
import { int } from "./create.ts";

// ─── settings ────────────────────────────────────────────────────────────────

/** The request's settings over the defaults, every field checked (the body is untrusted). */
export function cleanLessonSettings(raw: unknown): LessonSettings {
	const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const d = DEFAULT_LESSON_SETTINGS;
	const model = typeof r.model === "string" ? r.model.trim() : "";
	return {
		model: /^[\w.\-[\]]{2,60}$/.test(model) ? model : d.model,
		language: (CREATE_LANGUAGES as readonly unknown[]).includes(r.language) ? (r.language as LessonSettings["language"]) : d.language,
		maxPerStatement: int(r.maxPerStatement, d.maxPerStatement, 1, LESSON_CARDS_PER_STATEMENT),
		concurrency: int(r.concurrency, d.concurrency, 1, 4),
	};
}

// ─── the statements a lesson offers ──────────────────────────────────────────

type StatementGraph = Pick<GraphSnapshot, "propositions" | "nodeSessions">;

/** The propositions one lesson touched, in graph order. */
export function lessonStatements(graph: StatementGraph, chatId: string): LessonStatement[] {
	return graph.propositions
		.filter((p) => (graph.nodeSessions[p.id] ?? []).includes(chatId))
		.map((p) => ({ nodeId: p.id, name: p.name, statement: p.statement }));
}

/** The named propositions that still exist, in graph order (a stale pick loses the node that was deleted since). */
export function pickedStatements(graph: StatementGraph, nodeIds: readonly string[]): LessonStatement[] {
	const wanted = new Set(nodeIds);
	return graph.propositions.filter((p) => wanted.has(p.id)).map((p) => ({ nodeId: p.id, name: p.name, statement: p.statement }));
}

/** Per statement, how many study cards already come from it (suspended ones do not count). */
export function graphCardCounts(cards: readonly StudyCard[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const c of cards) {
		if (c.origin.kind !== "graph" || c.suspended) continue;
		counts.set(c.origin.nodeId, (counts.get(c.origin.nodeId) ?? 0) + 1);
	}
	return counts;
}

export function withCardCounts(statements: readonly LessonStatement[], cards: readonly StudyCard[]): LessonStatementOption[] {
	const counts = graphCardCounts(cards);
	return statements.map((s) => ({ ...s, cards: counts.get(s.nodeId) ?? 0 }));
}

/** The statements the form ticks at first: those without a card yet. */
export const withoutCards = (statements: readonly LessonStatementOption[]): string[] => statements.filter((s) => s.cards === 0).map((s) => s.nodeId);

const plain = (html: string): string =>
	html
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<[^>]*>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.trim();

/** What the cards that already come from a statement ask, as plain lines (the prompt asks not to repeat them). */
export function existingCardTexts(cards: readonly StudyCard[], nodeId: string): string[] {
	return cards
		.filter((c) => c.origin.kind === "graph" && c.origin.nodeId === nodeId && !c.suspended)
		.map((c) => (c.kind === "cloze" ? plain(c.fields.Text ?? "") : `${plain(c.fields.Front ?? "")} → ${plain(c.fields.Back ?? "")}`))
		.filter((t) => t.length > 0 && t !== "→");
}

// ─── reading the model's answer ──────────────────────────────────────────────

type Candidate = { type: "basic"; front: string; back: string; extra: string } | { type: "cloze"; text: string; extra: string };

/** One card the model offered, checked; null when it is unusable (dropped quietly rather than shown broken). */
export function validateLessonCard(raw: unknown): Candidate | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const extra = cleanText(r.extra);
	if (r.type === "cloze") {
		const text = cleanText(r.text);
		return text && clozeOk(text).ok ? { type: "cloze", text, extra } : null;
	}
	if (r.type !== "basic") return null;
	const front = cleanText(r.front);
	const back = cleanText(r.back);
	return front && back ? { type: "basic", front, back, extra } : null;
}

const same = (a: Candidate, b: Candidate): boolean =>
	a.type === "cloze" ? b.type === "cloze" && norm(a.text) === norm(b.text) : b.type === "basic" && norm(a.front) === norm(b.front) && norm(a.back) === norm(b.back);

/**
 * The drafts of one statement from the model's answer: the usable cards (at most `max`, without exact repeats),
 * and the model's reason when it made none. `firstIndex` numbers the drafts after the page's kept ones.
 */
export function lessonDrafts(answer: Record<string, unknown>, page: number, max: number, firstIndex = 1): { cards: LessonDraft[]; note: string } {
	const found: Candidate[] = [];
	for (const raw of Array.isArray(answer.cards) ? answer.cards : []) {
		const card = validateLessonCard(raw);
		if (card && !found.some((f) => same(f, card))) found.push(card);
		if (found.length >= max) break;
	}
	const cards = found.map((c, i): LessonDraft => ({ ...c, id: cardId(page, firstIndex + i), page, deleted: false, include: true }));
	return { cards, note: cards.length === 0 ? cleanText(answer.note).slice(0, 300) : "" };
}

// ─── editing ─────────────────────────────────────────────────────────────────

/**
 * Applies the learner's changes to one draft: its texts, whether it is selected, throwing it away / bringing it
 * back. Everything is checked first, so a refused edit changes nothing. Changing a text marks the draft edited.
 */
export function applyLessonEdit(c: LessonDraft, body: Record<string, unknown>): void {
	const keys = c.type === "cloze" ? (["text", "extra"] as const) : (["front", "back", "extra"] as const);
	const texts: Record<string, string> = {};
	for (const key of keys) {
		if (!(key in body)) continue;
		const value = cleanText(body[key]);
		if (key === "text") {
			const { ok, why } = clozeOk(value);
			if (!ok) throw new CardEditError(`The gap text is invalid: ${why}`);
		}
		if (key !== "extra" && !value) throw new CardEditError("This field must not be empty.");
		texts[key] = value;
	}
	Object.assign(c, texts);
	if (Object.keys(texts).length > 0) c.edited = true;
	if ("include" in body) c.include = Boolean(body.include);
	if ("deleted" in body) c.deleted = Boolean(body.deleted);
}

// ─── adoption ────────────────────────────────────────────────────────────────

export interface LessonAdoptContext {
	jobId: string;
	jobName: string;
	courseId: string;
	statement: LessonStatement;
	/** ISO time of the adoption. */
	at: string;
}

const gapNumbers = (text: string): number[] => [...new Set([...text.matchAll(new RegExp(CLOZE_RE))].map((m) => Number(m[1])))].sort((a, b) => a - b);

/** A draft → its study cards: always core knowledge (tier 1), tied to the statement it came from. A basic draft is one card, a cloze one per gap. */
export function lessonStudyCards(c: LessonDraft, ctx: LessonAdoptContext): StudyCard[] {
	const make = (k: number, kind: StudyCard["kind"], fields: Record<string, string>, variant?: number): StudyCard => ({
		id: studyCardId(ctx.jobId, c.id, k),
		courseId: ctx.courseId,
		topic: ctx.jobName,
		kind,
		fields,
		tags: [`Create::${tagPart(ctx.jobName)}`],
		core: true,
		tier: 1,
		origin: { kind: "graph", nodeId: ctx.statement.nodeId, jobId: ctx.jobId, draftId: c.id },
		...(variant === undefined ? {} : { variant }),
		createdAt: ctx.at,
	});
	const source = ctx.jobName;
	const extra = fmt(c.extra);
	if (c.type === "cloze") {
		const fields = { Text: fmt(c.text), Extra: extra, Source: source };
		return gapNumbers(c.text).map((n, k) => make(k, "cloze", fields, n - 1));
	}
	return [make(0, "basic", { Front: fmt(c.front), Back: fmt(c.back), Extra: extra, Source: source, Reverse: "" })];
}

/** The id numbers of a page's drafts continue after the highest one (also after deletions). */
export const nextDraftIndex = (cards: readonly { id: string }[]): number => Math.max(0, ...cards.map((c) => Number(/-c(\d+)$/.exec(c.id)?.[1] ?? 0))) + 1;
