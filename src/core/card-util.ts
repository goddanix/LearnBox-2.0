/**
 * Small pure helpers of the card pipeline (Learnbox 2.0, 2026-11): cleaning the
 * model's text, tags and boxes, and the box arithmetic the normaliser and the
 * duplicate check share. Ported from MedAnki's medanki/cards.py.
 */

import type { Box, PageLayout } from "./contracts/page-layout.ts";
import type { CardTier } from "./contracts/create-cards.ts";

export const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

// ─── text ────────────────────────────────────────────────────────────────────

/** Model text → plain text (HTML leftovers out). Escaping happens when the card is rendered. */
export function cleanText(v: unknown): string {
	if (v === null || v === undefined) return "";
	return String(v)
		.replace(/\r/g, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/?(?:b|i|u|strong|em|div|p|span|sub|sup)[^>]*>/gi, "")
		.trim();
}

export function clozeOk(text: string): { ok: boolean; why: string } {
	const found = [...text.matchAll(CLOZE_RE)];
	if (found.length === 0) return { ok: false, why: "no gap {{c1::…}} in it" };
	if (text.split("{{c").length - 1 !== found.length) return { ok: false, why: "cloze syntax is broken" };
	return { ok: true, why: "" };
}

export function clozePlain(text: string, reveal = true): string {
	return text.replace(CLOZE_RE, (_m, _n, answer: string) => (reveal ? answer : "[…]"));
}

/** A list or a comma-separated string (a form field). Only the comma separates — a space belongs to the tag ("Heat and Temperature"). */
export function cleanTags(tags: unknown): string[] {
	const list = typeof tags === "string" ? tags.split(",") : Array.isArray(tags) ? tags : [];
	const out: string[] = [];
	for (const t of list) {
		const tag = String(t)
			.trim()
			.replace(/[^\p{L}\p{N}_\-: ]/gu, "_")
			.replace(/\s+/g, " ")
			.replace(/_+/g, "_")
			.replace(/^[_ ]+|[_ ]+$/g, "");
		if (tag && !out.includes(tag)) out.push(tag);
	}
	return out.slice(0, 4);
}

/** Words of three letters or more, lower-case (Unicode: Czech and German letters count). */
export function tokens(s: string): Set<string> {
	return new Set((s ?? "").toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []);
}

/** Lower-case letters and digits only, for comparing texts. */
export function norm(s: string): string {
	return (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, "");
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	return inter / (a.size + b.size - inter);
}

export function clampTier(v: unknown): CardTier {
	const n = typeof v === "number" ? Math.trunc(v) : typeof v === "string" ? Number.parseInt(v, 10) : NaN;
	if (!Number.isFinite(n)) return 2;
	return Math.max(1, Math.min(3, n)) as CardTier;
}

// ─── boxes ───────────────────────────────────────────────────────────────────

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

/** Four numbers x0 < x1, y0 < y1 within the page (a hair of tolerance for the model's rounding). */
export function validBbox(b: unknown): b is number[] {
	if (!Array.isArray(b) || b.length !== 4) return false;
	const [x0, y0, x1, y1] = b.map(num) as [number, number, number, number];
	if (![x0, y0, x1, y1].every(Number.isFinite)) return false;
	return x0 >= 0 && x0 < x1 && x1 <= 1.0001 && y0 >= 0 && y0 < y1 && y1 <= 1.0001;
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function clampBbox(b: readonly unknown[]): Box {
	return b.map((v) => round4(Math.max(0, Math.min(1, num(v))))) as Box;
}

export function union(boxes: readonly Box[]): Box {
	return [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
}

export function padBbox(b: Box, m: number): Box {
	return [Math.max(0, b[0] - m), Math.max(0, b[1] - m), Math.min(1, b[2] + m), Math.min(1, b[3] + m)];
}

export function bboxArea(b: Box): number {
	return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

/** Intersection area relative to the smaller box (0 = apart, 1 = one lies inside the other). */
export function bboxOverlapRatio(a: Box, b: Box): number {
	const iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
	const ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
	if (iw <= 0 || ih <= 0) return 0;
	const small = Math.min(bboxArea(a), bboxArea(b));
	return small > 0 ? (iw * ih) / small : 0;
}

/** `{"ref": "F1"}` or `{"bbox": [...]}` (or a bare box) → a box in page coordinates. */
export function resolveRegion(spec: unknown, layout: Pick<PageLayout, "figures">): Box | null {
	if (typeof spec === "object" && spec !== null && !Array.isArray(spec)) {
		const s = spec as Record<string, unknown>;
		if (s.ref) {
			const fig = layout.figures.find((f) => f.id === String(s.ref));
			if (fig) return [...fig.bbox] as Box;
		}
		if (validBbox(s.bbox)) return clampBbox(s.bbox);
		return null;
	}
	if (validBbox(spec)) return clampBbox(spec);
	return null;
}

/** `"source": ["L4","L5"]` → the ids that exist, and the union of their boxes for the mark on the page. */
export function resolveSource(raw: Record<string, unknown>, lines: ReadonlyMap<string, { bbox: Box }>): { ids: string[]; bbox: Box | null } {
	const ids = (Array.isArray(raw.source) ? raw.source : []).map(String).filter((id) => lines.has(id));
	if (ids.length === 0) return { ids: [], bbox: null };
	return { ids, bbox: padBbox(union(ids.map((id) => lines.get(id)!.bbox)), 0.006) };
}
