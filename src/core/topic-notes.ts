/**
 * The notes of a course, one per topic (Learnbox 2.0, 2026-11): the pure rules of MedAnki's topic_notes.py and the
 * helpers of notes.py around them — what a page's text and figures give the model, how long a note may be, and how
 * the model's Markdown becomes Obsidian Markdown (source marks "(D1 S. 12)" → page links, "{{FIG …}}" → pictures).
 * The model calls and the files are in server/create-notes.ts, the prompt texts in agent/create/notes-prompts.ts;
 * tests/topic-notes.test.ts compares these functions with MedAnki's own output.
 */

import type { CardDraft } from "./contracts/create-cards.ts";
import type { NoteFigure, NoteSource, TopicNote } from "./contracts/create-notes.ts";
import type { PageLayout, PageLine } from "./contracts/page-layout.ts";
import { toInt } from "./course-topics.ts";
import { slug } from "./vault-text.ts";

/** Source pages of a topic (with more: those with the most cards). */
export const MAX_PAGES = 30;
/** Words of one source page that reach the model. */
export const PAGE_WORDS = 260;
/** Cards of a topic in the prompt. */
export const CARDS_MAX = 60;
/** Figures of a topic note, at most. */
export const TOPIC_FIGS = 4;
/** Figure candidates per topic. */
export const FIG_CANDIDATES = 8;
/** A note's words: not fewer, not more. */
export const WORDS_MIN = 350;
export const WORDS_MAX = 1400;
/** Calls at the same time. */
export const WORKERS = 2;
/** Page headings per call of the heading match. */
export const HEADING_BATCH = 80;
/** A note over this many times its word budget is cut. */
export const TRIM_FACTOR = 1.25;

const REF_RE = /\b(D\d+)\s+S\.\s*(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?/g;
const PAGEREF_RE = /\(\s*(?:S\.|Seiten?|p\.|pp\.)\s*(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?(?:\s*,\s*\d{1,4})*\s*\)/g;
const CAPTION_RE = /^\s*(?:Abb\.?|Abbildung|Fig\.?|Figure)\s*\d+/i;
// `{{FIG id | text}}` alone on a line (Python's re.M: `^` after a newline, `$` before one, `.` not the newline).
const FIG_RE = /(?:^|(?<=\n))[ \t]*\{\{\s*FIG[:\s]+(\S+?)\s*(?:\|\s*([^\n]*?))?\s*\}\}[ \t]*(?=\n|$)/g;

const chars = (s: string): string[] => [...s];

/** Python's `str.splitlines()`. */
function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/);
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Python's `round()`: halves to the even number. */
function pyRound(x: number): number {
	const f = Math.floor(x);
	const d = x - f;
	if (d < 0.5) return f;
	if (d > 0.5) return f + 1;
	return f % 2 === 0 ? f : f + 1;
}

/** Words of the text without frontmatter, picture embeds, page marks and Markdown signs. */
export function countWords(markdown: string): number {
	let text = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
	text = splitLines(text)
		.filter((ln) => {
			const t = ln.trimStart();
			return !(t.startsWith("![[") || t.startsWith("{{FIG"));
		})
		.join("\n");
	text = text.replace(PAGEREF_RE, " ");
	text = text.replace(/\[\[[^\]]*#page=[^\]]*\]\]/g, " "); // a page link is no text
	text = text.replace(/\[\[[^\]|]*\|?([^\]]*)\]\]/g, "$1");
	return (text.match(/[\p{L}\p{N}_][\p{L}\p{N}_\-'’]*/gu) ?? []).length;
}

/** The text of a page for the model: lines in reading order, "★" for what the original emphasises (bold / italic / underlined). */
export function pageText(layout: Pick<PageLayout, "lines">): string {
	const out: string[] = [];
	for (const ln of layout.lines) {
		if (ln.src === "legend") continue; // legend entries already stand as ordinary lines
		const t = (ln.text ?? "").trim();
		if (t) out.push((ln.bold || ln.italic || ln.underline ? "★ " : "") + t);
	}
	return out.join("\n");
}

/** The caption "Fig. 3: …" right under or over a figure, if there is one. */
export function captionFor(figBbox: readonly number[], lines: readonly Pick<PageLine, "text" | "bbox">[]): string {
	let best = "";
	let bestGap = 0.09;
	for (const ln of lines) {
		if (!CAPTION_RE.test(ln.text ?? "")) continue;
		const b = ln.bbox;
		if (b[2] < figBbox[0]! - 0.05 || b[0] > figBbox[2]! + 0.05) continue;
		const gap = Math.max(b[1] - figBbox[3]!, figBbox[1]! - b[3], 0);
		if (gap < bestGap) {
			best = ln.text.trim();
			bestGap = gap;
		}
	}
	return chars(best).slice(0, 160).join("");
}

/** A figure that would do in a note, before it is cut out of the page. */
export interface FigureCandidate {
	id: string;
	page: number;
	fig: string;
	bbox: [number, number, number, number];
	area: number;
	caption: string;
}

const figArea = (b: readonly number[]): number => (b[2]! - b[0]!) * (b[3]! - b[1]!);

/** The figures of the given pages that suit a note (not tiny, no full-page scans); those with a caption and the larger first, then by page. */
export function figureCandidates(pages: readonly { page: number; layout: Pick<PageLayout, "lines" | "figures"> }[], limit: number): FigureCandidate[] {
	const found: FigureCandidate[] = [];
	for (const p of pages) {
		for (const f of p.layout.figures) {
			const area = figArea(f.bbox);
			if (area < 0.05 || area > 0.85) continue;
			found.push({ id: `p${String(p.page).padStart(3, "0")}_${f.id}`, page: p.page, fig: f.id, bbox: f.bbox, area, caption: captionFor(f.bbox, p.layout.lines) });
		}
	}
	found.sort((a, b) => Number(Boolean(b.caption)) - Number(Boolean(a.caption)) || b.area - a.area);
	return found.slice(0, limit).sort((a, b) => a.page - b.page || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Lines in order until the word budget is reached (at least one line). */
export function trimWords(text: string, limit: number): string {
	const out: string[] = [];
	let n = 0;
	for (const ln of splitLines(text)) {
		const w = ln.split(/\s+/).filter(Boolean).length;
		if (out.length > 0 && n + w > limit) break;
		out.push(ln);
		n += w;
	}
	return out.join("\n");
}

/** The short name of a source for a link's label (without the leading number). */
export function shortName(name: string): string {
	const s = name.replace(/^\d+[_\s-]*/, "").trim();
	return (chars(s).slice(0, 40).join("") || chars(name).slice(0, 40).join("")).trim();
}

const refLink = (refs: Readonly<Record<string, NoteSource>>, ref: string, page: number, label: string): string => `[[${refs[ref]!.pdfFile}#page=${page}|${label}]]`;

/** Every source mark "D1 S. 12" in the text as a link to that page of the PDF (also inside lists like "(D1 S. 12, D2 S. 4)"). */
export function linkRefs(md: string, refs: Readonly<Record<string, NoteSource>>): string {
	return md.replace(REF_RE, (whole, ref: string, a: string, b: string | undefined) => {
		if (!(ref in refs)) return whole;
		const first = Number.parseInt(a, 10);
		return refLink(refs, ref, first, `${shortName(refs[ref]!.name)} · S. ${first}${b !== undefined ? `–${b}` : ""}`);
	});
}

/** Pictures as a paragraph of their own (a blank line before), so Obsidian does not pull them into a list. */
export function tidy(md: string): string {
	return `${md.replace(/([^\n])\n(!\[\[)/g, "$1\n\n$2").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/** A figure candidate with where it is kept once cut out. */
export interface NoteFigureCandidate {
	id: string;
	page: number;
	ref: string;
	src: string;
	caption: string;
}

/** `{{FIG id | text}}` → a picture with its caption, "(D1 S. 12-14)" → a link to the page in source D1. → the Markdown and the figures used */
export function toObsidianTopic(markdown: string, o: { topic: string; refs: Readonly<Record<string, NoteSource>>; cands: readonly NoteFigureCandidate[]; maxFigs: number }): { markdown: string; used: NoteFigure[] } {
	let md = markdown.replace(/\r\n/g, "\n").trim().replace(/^# [^\n]*\n+/, ""); // the title is the topic
	const byId = new Map(o.cands.map((c) => [c.id, c]));
	const used: NoteFigure[] = [];
	md = md.replace(FIG_RE, (_whole, id: string, text: string | undefined) => {
		const c = byId.get(id);
		if (!c || used.some((u) => u.id === c.id) || used.length >= o.maxFigs) return ""; // unknown, twice or over the limit
		const caption = (text || c.caption || "Abbildung").trim().replace(/\.+$/, "");
		const file = `${slug(o.topic, 30)}_${c.id}.png`;
		used.push({ id: c.id, file, src: c.src, page: c.page, ref: c.ref, caption });
		const link = refLink(o.refs, c.ref, c.page, `${shortName(o.refs[c.ref]!.name)} · S. ${c.page}`);
		return `\n![[${file}|560]]\n*Abb.: ${caption}* ${link}\n`;
	});
	return { markdown: tidy(linkRefs(md, o.refs)), used };
}

/** The word budget of a note: half the source text, between the limits. */
export function wordBudget(sourceWords: number): number {
	return Math.max(WORDS_MIN, Math.min(WORDS_MAX, pyRound(0.5 * sourceWords)));
}

/** The pages of a topic, most cards first (at most MAX_PAGES), then in PDF and page order. */
export function sourcePages(cards: readonly { jobId: string; page: number }[], order: ReadonlyMap<string, number>): { jobId: string; page: number }[] {
	const per = new Map<string, number>();
	for (const c of cards) per.set(`${c.jobId}|${c.page}`, (per.get(`${c.jobId}|${c.page}`) ?? 0) + 1);
	const keys = [...per.keys()].map((k) => {
		const at = k.lastIndexOf("|");
		return { jobId: k.slice(0, at), page: Number(k.slice(at + 1)), n: per.get(k)! };
	});
	keys.sort((a, b) => b.n - a.n || order.get(a.jobId)! - order.get(b.jobId)! || a.page - b.page);
	return keys
		.slice(0, MAX_PAGES)
		.sort((a, b) => order.get(a.jobId)! - order.get(b.jobId)! || a.page - b.page)
		.map(({ jobId, page }) => ({ jobId, page }));
}

/** The first row of a note set: nothing written yet (or nothing to write it from). */
export function stub(ix: number, topic: string, nCards: number, nHeadingPages = 0): TopicNote {
	const hasMaterial = nCards > 0 || nHeadingPages > 0;
	return {
		id: `t${String(ix).padStart(2, "0")}`,
		ix,
		topic,
		kind: hasMaterial ? "pending" : "skipped",
		skipReason: hasMaterial ? "" : "No cards are assigned to this topic and no page heading matches it.",
		cards: nCards,
		pages: 0,
		refs: [],
		markdown: "",
		words: 0,
		figures: [],
		include: true,
		error: "",
	};
}

/** The cards a topic note rests on: not thrown away and selected, by topic label. */
export function cardsByTopic<T extends { card: Pick<CardDraft, "deleted" | "include" | "tags"> }>(items: readonly T[], topics: ReadonlySet<string>): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const item of items) {
		if (item.card.deleted || !item.card.include) continue;
		for (const t of item.card.tags) {
			if (topics.has(t)) out.set(t, [...(out.get(t) ?? []), item]);
		}
	}
	return out;
}

/** The model's answer to the heading match → topic → [(job, page)] (unusable parts left out). */
export function parseHeadingAssignments(raw: unknown, keys: ReadonlySet<string>, topics: readonly string[]): Map<string, { jobId: string; page: number }[]> {
	const out = new Map<string, { jobId: string; page: number }[]>();
	const list = typeof raw === "object" && raw !== null && Array.isArray((raw as { assignments?: unknown }).assignments) ? ((raw as { assignments: unknown[] }).assignments) : [];
	for (const a of list) {
		if (typeof a !== "object" || a === null || Array.isArray(a)) continue;
		const rec = a as Record<string, unknown>;
		const id = rec.id === null || rec.id === undefined || rec.id === "" || rec.id === 0 || rec.id === false ? "" : String(rec.id);
		if (!keys.has(id)) continue;
		const n = toInt(rec.topic);
		if (n === null || n < 1 || n > topics.length) continue;
		const at = id.lastIndexOf(":");
		const topic = topics[n - 1]!;
		out.set(topic, [...(out.get(topic) ?? []), { jobId: id.slice(0, at), page: Number.parseInt(id.slice(at + 1), 10) }]);
	}
	return out;
}
