/**
 * Page layout rules (Learnbox 2.0, 2026-11): runs of shown text → lines with
 * ids, boxes and emphasis; painted shapes → figure regions. Pure — the PDF
 * reader (src/agent/layout) hands over a RawPage, this turns it into the
 * PageLayout a prompt and the mask planner work on. A port of MedAnki's
 * medanki/pdfio.py (PyMuPDF); thresholds are the originals unless a comment
 * says otherwise.
 */

import type { Box, PageFigure, PageFigureKind, PageLayout, PageLine, PageWord, RawPage, RawTextItem, Rect } from "./contracts/page-layout.ts";

const round = (v: number, digits: number) => {
	const f = 10 ** digits;
	return Math.round(v * f) / f;
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** A rect in points → a page-normalised box (4 decimals, clipped to the page). */
export function normRect(r: Rect, w: number, h: number): Box {
	return [round(clamp01(r[0] / w), 4), round(clamp01(r[1] / h), 4), round(clamp01(r[2] / w), 4), round(clamp01(r[3] / h), 4)];
}

export const boxArea = (b: readonly number[]) => Math.max(0, b[2]! - b[0]!) * Math.max(0, b[3]! - b[1]!);

/** Is the centre of `box` inside `region`? */
export function centerIn(box: readonly number[], region: readonly number[]): boolean {
	const cx = (box[0]! + box[2]!) / 2;
	const cy = (box[1]! + box[3]!) / 2;
	return region[0]! <= cx && cx <= region[2]! && region[1]! <= cy && cy <= region[3]!;
}

// ─── lines ────────────────────────────────────────────────────────────────────

/** Bold / italic from the font's name (PDF font flags are not reachable through pdfjs). */
export function fontEmphasis(font: string): { bold: boolean; italic: boolean } {
	const name = font.toLowerCase();
	return {
		bold: ["bold", "black", "heavy", "semibold"].some((k) => name.includes(k)),
		italic: ["italic", "oblique"].some((k) => name.includes(k)),
	};
}

/** A gap wider than this many font sizes between where one run ends and the next starts (a column gap) starts a new line. */
const MAX_JOIN_GAP = 0.8;
/** A blank run advancing the pen further than this many font sizes is padding between cells, not a space. */
const WIDE_SPACE = 2;
/** ... and a gap of at least this many font sizes between joined runs is a word space. */
const SPACE_GAP = 0.15;
/** Runs whose baselines differ by less than this many font sizes share a line (raised or lowered text included). */
const BASELINE_TOLERANCE = 0.5;

interface Run {
	items: RawTextItem[];
	text: string;
	x0: number;
	/** End of the last visible glyph (trailing whitespace advances the pen but is no ink). */
	x1: number;
	/** Where the pen stands after the last run, whitespace included. */
	pen: number;
	/** Horizontal extent of every character of `text` (spread evenly over its run — the PDF gives no glyph widths). */
	cx: [number, number][];
	/** Baseline of the largest run so far — superscripts are measured against it. */
	baseline: number;
	size: number;
}

/** Extent of a run's visible text along the baseline: leading and trailing whitespace take room but are no glyphs. */
function visible(item: RawTextItem): [number, number] | null {
	if (item.str.trim() === "") return null;
	const w = item.x1 - item.x;
	const lead = item.str.length - item.str.trimStart().length;
	const trail = item.str.length - item.str.trimEnd().length;
	return [item.x + (w * lead) / item.str.length, item.x1 - (w * trail) / item.str.length];
}

function charSpans(item: RawTextItem): [number, number][] {
	const n = item.str.length;
	const w = item.x1 - item.x;
	return Array.from({ length: n }, (_, i): [number, number] => [item.x + (w * i) / n, item.x + (w * (i + 1)) / n]);
}

const startRun = (item: RawTextItem): Run => {
	const v = visible(item);
	return {
		items: [item],
		text: item.str,
		x0: v ? v[0] : Infinity,
		x1: v ? v[1] : -Infinity,
		pen: item.x1,
		cx: charSpans(item),
		baseline: item.baseline,
		size: item.size,
	};
};

function joinsRun(run: Run, item: RawTextItem): boolean {
	const last = run.items[run.items.length - 1]!;
	if (!item.horizontal || !last.horizontal) return false;
	const size = Math.max(run.size, item.size);
	if (Math.abs(item.baseline - run.baseline) > BASELINE_TOLERANCE * size) return false;
	// the gap is measured from the pen, so a space run between two words closes the gap itself
	const gap = item.x - run.pen;
	if (gap < -0.5 * size || gap > MAX_JOIN_GAP * size) return false;
	return visible(item) !== null || item.x1 - item.x <= WIDE_SPACE * size;
}

function addToRun(run: Run, item: RawTextItem): void {
	const v = visible(item);
	if (v) {
		const gap = item.x - run.pen;
		const spaced = /\s$/.test(run.text) || /^\s/.test(item.str);
		if (gap >= SPACE_GAP * run.size && !spaced) {
			run.text += " ";
			run.cx.push([run.pen, item.x]);
		}
		run.text += item.str;
		run.x0 = Math.min(run.x0, v[0]);
		run.x1 = Math.max(run.x1, v[1]);
	} else run.text += item.str;
	run.cx.push(...charSpans(item));
	run.pen = item.x1;
	run.items.push(item);
	if (item.size > run.size) {
		run.size = item.size;
		run.baseline = item.baseline;
	}
}

/** Runs of text in stream order → lines: same baseline and no jump back or wide gap keeps a run going. */
export function groupRuns(items: readonly RawTextItem[]): Run[] {
	const runs: Run[] = [];
	let cur: Run | null = null;
	for (const item of items) {
		if (item.str === "") continue;
		if (cur && joinsRun(cur, item)) addToRun(cur, item);
		else {
			if (cur) runs.push(cur);
			cur = startRun(item);
		}
	}
	if (cur) runs.push(cur);
	return runs;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Line box in points: from the fonts' ascent / descent (a plain 0.8 / 0.2 for a font that names none). */
function runRect(run: Run): Rect {
	const first = run.items[0]!;
	if (!first.horizontal) {
		const rects = run.items.map((i) => i.rect);
		return [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))];
	}
	let y0 = Infinity;
	let y1 = -Infinity;
	for (const it of run.items) {
		const up = it.ascent > 0 ? it.ascent : 0.8;
		const down = it.descent < 0 ? it.descent : -0.2;
		y0 = Math.min(y0, it.baseline - up * it.size);
		y1 = Math.max(y1, it.baseline - down * it.size);
	}
	return [run.x0, y0, run.x1, y1];
}

/**
 * Tight line box: the font's ascender / descender overhang (taller than the glyphs) pokes into
 * neighbouring lines at tight leading. Baseline − 0.80·size … + 0.24·size holds capitals, umlauts and
 * descenders but no neighbour line. Horizontal text only.
 */
function tightRect(run: Run, rect: Rect, spans: RawTextItem[]): Rect | null {
	if (!run.items[0]!.horizontal || spans.length === 0) return null;
	const baseline = median(spans.map((s) => s.baseline));
	const size = Math.max(...spans.map((s) => s.size));
	const top = Math.max(rect[1], baseline - 0.8 * size);
	const bottom = Math.min(rect[3], baseline + 0.24 * size);
	if (bottom - top < 0.5 * size) return null;
	return [rect[0], top, rect[2], bottom];
}

/** Thin bars directly under a line (at least half its width) are an underline — PDF has no underline attribute. */
function underlined(rect: Rect, rules: readonly Rect[]): boolean {
	const width = rect[2] - rect[0];
	if (width <= 0) return false;
	let covered = 0;
	for (const s of rules) {
		if (s[1] < rect[1] - 1 || s[1] > rect[3] + 4) continue;
		const lo = Math.max(s[0], rect[0]);
		const hi = Math.min(s[2], rect[2]);
		if (hi > lo) covered += hi - lo;
	}
	return covered / width >= 0.5;
}

/** The words of a horizontal run: split at whitespace, each boxed from its characters' extent and the line's height. */
function wordsOf(run: Run, band: Rect, W: number, H: number): PageWord[] | undefined {
	if (!run.items[0]!.horizontal) return undefined;
	const words: PageWord[] = [];
	let start = -1;
	const flush = (end: number) => {
		if (start < 0) return;
		const x0 = run.cx[start]![0];
		const x1 = run.cx[end - 1]![1];
		words.push({ t: run.text.slice(start, end), b: normRect([x0, band[1], x1, band[3]], W, H) });
		start = -1;
	};
	for (let i = 0; i < run.text.length; i++) {
		if (/\s/.test(run.text[i]!)) flush(i);
		else if (start < 0) start = i;
	}
	flush(run.text.length);
	return words;
}

/** Lines without figure membership (that needs the figure regions, which need the lines). */
function buildLines(page: RawPage): PageLine[] {
	const { widthPt: W, heightPt: H } = page;
	const lines: PageLine[] = [];
	for (const run of groupRuns(page.items)) {
		const text = run.text.split(/\s+/).filter(Boolean).join(" ");
		const spans = run.items.filter((i) => i.str.trim() !== "");
		if (!text || spans.length === 0) continue;
		const rect = runRect(run);
		const tight = tightRect(run, rect, spans);
		const chars = spans.reduce((n, s) => n + s.str.length, 0) || 1;
		const words = wordsOf(run, tight ?? rect, W, H);
		let bold = 0;
		let italic = 0;
		for (const s of spans) {
			const e = fontEmphasis(s.font);
			if (e.bold) bold += s.str.length;
			if (e.italic) italic += s.str.length;
		}
		lines.push({
			id: `L${lines.length + 1}`,
			text,
			bbox: normRect(rect, W, H),
			tight: tight ? normRect(tight, W, H) : null,
			size: round(Math.max(...spans.map((s) => s.size)), 1),
			src: "pdf",
			bold: bold / chars >= 0.6,
			italic: italic / chars >= 0.6,
			underline: run.items[0]!.horizontal && underlined(rect, page.rules),
			inFigure: false,
			...(words ? { words } : {}),
		});
	}
	return lines;
}

// ─── figures ──────────────────────────────────────────────────────────────────

interface Region {
	kind: PageFigureKind;
	bbox: Box;
}

/** Merge regions that touch or lie closer than `gap` (normalised), until none do; raster wins over vector. */
export function mergeRegions<T extends Region>(input: readonly T[], gap: number): T[] {
	const figs = input.map((f) => ({ ...f, bbox: [...f.bbox] as Box }));
	let changed = true;
	while (changed) {
		changed = false;
		outer: for (let i = 0; i < figs.length; i++) {
			for (let j = i + 1; j < figs.length; j++) {
				const a = figs[i]!.bbox;
				const b = figs[j]!.bbox;
				if (a[0] - gap <= b[2] && b[0] - gap <= a[2] && a[1] - gap <= b[3] && b[1] - gap <= a[3]) {
					figs[i]!.bbox = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
					if (figs[j]!.kind === "raster") figs[i]!.kind = "raster";
					figs.splice(j, 1);
					changed = true;
					break outer;
				}
			}
		}
	}
	return figs;
}

/** Short text lines right next to a figure (labels on guide lines) belong to it. */
function absorbLabels(figs: Region[], lines: readonly PageLine[], margin = 0.035): void {
	for (const f of figs) {
		for (let pass = 0; pass < 3; pass++) {
			const grown = [f.bbox[0] - margin, f.bbox[1] - margin, f.bbox[2] + margin, f.bbox[3] + margin];
			let changed = false;
			for (const ln of lines) {
				if (ln.text.split(/\s+/).length > 6 || /^(Abb|Fig|Quelle)/.test(ln.text)) continue;
				const lb = ln.bbox;
				if (lb[2] < grown[0]! || lb[0] > grown[2]! || lb[3] < grown[1]! || lb[1] > grown[3]!) continue;
				const b = f.bbox;
				const nb: Box = [Math.min(b[0], lb[0]), Math.min(b[1], lb[1]), Math.max(b[2], lb[2]), Math.max(b[3], lb[3])];
				if (nb.some((v, i) => v !== b[i])) {
					f.bbox = nb;
					changed = true;
				}
			}
			if (!changed) break;
		}
	}
}

/** Group rectangles that overlap or lie within `tol` points of each other (PyMuPDF's cluster_drawings). */
export function clusterRects(rects: readonly Rect[], tol = 3): Rect[] {
	const out: Rect[] = rects.map((r) => [...r] as Rect);
	let changed = true;
	while (changed) {
		changed = false;
		outer: for (let i = 0; i < out.length; i++) {
			for (let j = i + 1; j < out.length; j++) {
				const a = out[i]!;
				const b = out[j]!;
				if (a[0] - tol <= b[2] && b[0] - tol <= a[2] && a[1] - tol <= b[3] && b[1] - tol <= a[3]) {
					out[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
					out.splice(j, 1);
					changed = true;
					break outer;
				}
			}
		}
	}
	return out;
}

const rectArea = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);

function clipToPage(r: Rect, W: number, H: number): Rect | null {
	const c: Rect = [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(W, r[2]), Math.min(H, r[3])];
	return c[2] > c[0] && c[3] > c[1] ? c : null;
}

/** Raster images and vector clusters (diagrams) with their labels, top to bottom. */
export function figureRegions(page: RawPage, lines: readonly PageLine[]): PageFigure[] {
	const { widthPt: W, heightPt: H } = page;
	const pageArea = W * H;
	const found: { kind: PageFigureKind; rect: Rect }[] = [];
	for (const img of page.images) {
		const r = clipToPage(img, W, H);
		if (!r || rectArea(r) < 0.02 * pageArea || Math.min(r[2] - r[0], r[3] - r[1]) < 0.06 * Math.min(W, H)) continue;
		found.push({ kind: "raster", rect: r });
	}
	// a shape covering (almost) the whole page is a background, and would glue every drawing into one cluster
	const shapes = page.drawings.filter((r) => rectArea(r) < 0.9 * pageArea);
	for (const cluster of clusterRects(shapes)) {
		const r = clipToPage(cluster, W, H);
		if (!r || rectArea(r) < 0.01 * pageArea || r[2] - r[0] < 0.06 * W || r[3] - r[1] < 0.05 * H) continue;
		found.push({ kind: "vector", rect: r });
	}
	// background areas are no figures
	const kept = found.filter((f) => rectArea(f.rect) < 0.92 * pageArea);

	let figs: Region[] = kept.map((f) => ({ kind: f.kind, bbox: normRect(f.rect, W, H) }));
	figs = mergeRegions(figs, 0.03);
	if (lines.length > 0) {
		absorbLabels(figs, lines);
		figs = mergeRegions(figs, 0);
	}
	// tiny leftovers (rules, frames) are dropped
	figs = figs.filter((f) => boxArea(f.bbox) >= 0.03);
	figs.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
	return figs.map((f, i) => ({ id: `F${i + 1}`, kind: f.kind, bbox: f.bbox.map((v) => round(v, 4)) as Box }));
}

// ─── the page ─────────────────────────────────────────────────────────────────

/** The most title-like line: large, near the top (the first of equally large ones). */
export function guessTitle(lines: readonly PageLine[]): string {
	const top = lines.filter((l) => l.bbox[1] < 0.35 && l.text.length > 2);
	const pool = top.length > 0 ? top : lines;
	let best: PageLine | undefined;
	for (const l of pool) {
		if (!best || l.size > best.size || (l.size === best.size && l.bbox[1] < best.bbox[1])) best = l;
	}
	return best ? best.text.slice(0, 90) : "";
}

export function extractLayout(page: RawPage): PageLayout {
	const lines = buildLines(page);
	const figures = figureRegions(page, lines);
	for (const ln of lines) ln.inFigure = figures.some((f) => centerIn(ln.bbox, f.bbox));
	return {
		widthPt: page.widthPt,
		heightPt: page.heightPt,
		lines,
		figures,
		legends: [],
		chars: lines.reduce((n, l) => n + l.text.length, 0),
		title: guessTitle(lines),
	};
}

// ─── text that exists only as picture ─────────────────────────────────────────

/** Overlap area as a share of the smaller box. */
function overlapShare(a: readonly number[], b: readonly number[]): number {
	const iw = Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!);
	const ih = Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!);
	if (iw <= 0 || ih <= 0) return 0;
	const small = Math.min(boxArea(a), boxArea(b));
	return small > 0 ? (iw * ih) / small : 0;
}

/**
 * Where OCR is worth running: the whole page when the PDF has (almost) no text layer — a scan — else every
 * raster figure with fewer than three text lines of its own (labels inside the picture).
 */
export function ocrRegions(layout: PageLayout): Box[] {
	if (layout.chars < 30) return [[0, 0, 1, 1]];
	const regions: Box[] = [];
	for (const f of layout.figures) {
		if (f.kind !== "raster") continue;
		const inside = layout.lines.filter((l) => centerIn(l.bbox, f.bbox)).length;
		if (inside < 3) regions.push(f.bbox);
	}
	return regions;
}

/** The layout with OCR lines ("O1…") added for text that is not in the text layer (lines already covered are skipped). */
export function withOcrLines(layout: PageLayout, found: readonly PageLine[]): PageLayout {
	const out: PageLayout = structuredClone(layout);
	let k = 0;
	for (const r of found) {
		if (out.lines.some((l) => overlapShare(r.bbox, l.bbox) > 0.5)) continue;
		k++;
		out.lines.push({ ...structuredClone(r), id: `O${k}`, inFigure: out.figures.some((f) => centerIn(r.bbox, f.bbox)) });
	}
	out.chars = out.lines.reduce((n, l) => n + l.text.length, 0);
	if (!out.title && out.lines.length > 0) {
		const top = [...out.lines].sort((a, b) => a.bbox[1] - b.bbox[1])[0]!;
		out.title = top.text.slice(0, 90);
	}
	return out;
}
