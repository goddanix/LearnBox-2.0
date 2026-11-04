/**
 * Legends at a figure's edge (Learnbox 2.0, 2026-11). Many lecture figures name their parts not in the
 * picture but in a LEGEND beside it: numbers or letters in the figure plus a list "1 Aorta / 2 Truncus …",
 * or colour swatches plus names. Such figures make ideal occlusion cards — the legend's text is covered
 * (exact text box; number or swatch stays visible). Without help a model usually turns them into a plain
 * image question because the name "is not in the picture".
 *
 * `annotateLegends` adds to a page layout
 *  - `legends`: [{ id "LG1", kind, figure, bbox, entries [G-ids], markersInFigure, confident }],
 *  - one line per legend entry ("G1…", src "legend": the NAME part with its exact box),
 *  - the figure box grown to cover figure AND legend.
 *
 * Everything is heuristic and must never disturb the page: the caller keeps the unannotated layout when
 * this throws. A port of MedAnki's medanki/legend.py.
 */

import type { Box, LegendKind, PageFigure, PageLayout, PageLegend, PageLine, PageWord, Raster, Rect } from "./contracts/page-layout.ts";
import { centerIn, clusterRects, normRect } from "./page-layout.ts";

const MIN_ENTRIES = 3; // consecutive markers / swatches a legend needs
const MAX_ENTRIES = 24;
const MAX_GAP = 0.12; // largest distance (page fraction) between legend and figure
const FAR_GAP = 0.4; // ... when the legend's numbers / letters also stand in the figure (wide slides: legend far right)
const SWATCH_GAP = 0.3; // ... for colour legends (swatches are a strong signal)
const MAX_STEP = 0.5; // largest distance between two consecutive entries (two-column legends)
const MAX_NAME_WORDS = 12;
const MAX_NAME_CHARS = 90;
const MAX_MEAN_WORDS = 6;

const CIRCLED = new Map<string, number>(Array.from({ length: 20 }, (_, i): [string, number] => [String.fromCharCode(0x2460 + i), i + 1]));
const SEPS = new Set(["=", "-", "–", "—", ":", "→", ".", ")", "·"]);

type MarkerKind = "n" | "U" | "l";
const KIND_LABEL: Record<MarkerKind | "swatch", LegendKind> = { n: "numbered", U: "lettered", l: "lettered", swatch: "swatch" };

// ─── geometry ────────────────────────────────────────────────────────────────

const union = (boxes: readonly (readonly number[])[]): Box => [
	Math.min(...boxes.map((b) => b[0]!)),
	Math.min(...boxes.map((b) => b[1]!)),
	Math.max(...boxes.map((b) => b[2]!)),
	Math.max(...boxes.map((b) => b[3]!)),
];

/** Distance between two rectangles (0 when they overlap). */
function gap(a: readonly number[], b: readonly number[]): number {
	const dx = Math.max(0, a[0]! - b[2]!, b[0]! - a[2]!);
	const dy = Math.max(0, a[1]! - b[3]!, b[1]! - a[3]!);
	return Math.hypot(dx, dy);
}

/** Overlap area as a share of the smaller rectangle. */
function overlapRatio(a: readonly number[], b: readonly number[]): number {
	const iw = Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!);
	const ih = Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!);
	if (iw <= 0 || ih <= 0) return 0;
	const small = Math.min((a[2]! - a[0]!) * (a[3]! - a[1]!), (b[2]! - b[0]!) * (b[3]! - b[1]!));
	return small > 0 ? (iw * ih) / small : 0;
}

const center = (b: readonly number[]): [number, number] => [(b[0]! + b[2]!) / 2, (b[1]! + b[3]!) / 2];

function dist(a: { bbox: readonly number[] }, b: { bbox: readonly number[] }): number {
	const [ax, ay] = center(a.bbox);
	const [bx, by] = center(b.bbox);
	return Math.hypot(ax - bx, ay - by);
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

// ─── markers and entries ─────────────────────────────────────────────────────

interface Marker {
	kind: MarkerKind;
	value: number;
	/** Name start glued to the marker ("1.Aorta" → "Aorta"). */
	rest: string;
}

const HAS_TWO_LETTERS = /\p{L}.*\p{L}/su;

/** A token as a legend marker, or null. Numbers 1–99, capitals, lower-case letters only with punctuation ("a)"). */
export function parseMarker(tok: string): Marker | null {
	const circled = CIRCLED.get(tok);
	if (circled !== undefined) return { kind: "n", value: circled, rest: "" };
	let m = /^\(?(\d{1,2})[.):\]]?$/.exec(tok);
	if (m) return { kind: "n", value: Number(m[1]), rest: "" };
	m = /^\(?([A-Z])[.):\]]?$/.exec(tok);
	if (m) return { kind: "U", value: m[1]!.charCodeAt(0) - 64, rest: "" };
	m = /^\(?([a-z])[.):\]]$/.exec(tok);
	if (m) return { kind: "l", value: m[1]!.charCodeAt(0) - 96, rest: "" };
	m = /^\(?(\d{1,2})[.):=\-–]+(\S{2,})$/u.exec(tok);
	if (m && /\p{L}{2}/u.test(m[2]!)) return { kind: "n", value: Number(m[1]), rest: m[2]! };
	m = /^\(?([A-Za-z])[.):=]+(\S{2,})$/u.exec(tok);
	if (m && /\p{L}{2}/u.test(m[2]!)) return { kind: m[1]! === m[1]!.toUpperCase() ? "U" : "l", value: m[1]!.toUpperCase().charCodeAt(0) - 64, rest: m[2]! };
	return null;
}

interface Token {
	t: string;
	b: Box;
}

/** Words of a line without word boxes: spread over the line box by character position. */
function proportionalTokens(text: string, bbox: Box): Token[] {
	const n = Math.max(text.length, 1);
	const w = bbox[2] - bbox[0];
	return [...text.matchAll(/\S+/g)].map((m): Token => ({ t: m[0], b: [bbox[0] + (w * m.index!) / n, bbox[1], bbox[0] + (w * (m.index! + m[0].length)) / n, bbox[3]] }));
}

interface Entry {
	kind: MarkerKind | "swatch";
	value: number;
	marker: string;
	text: string;
	line: string;
	bbox: Box;
}

/** "Marker + name" entries of one line; several per line ("A Epidermis, B Dermis") are told apart. */
function entriesInLine(tokens: readonly Token[], line: PageLine): Entry[] {
	const starts: { i: number; kind: MarkerKind; value: number; rest: string }[] = [];
	tokens.forEach((tk, i) => {
		const pm = parseMarker(tk.t);
		if (!pm) return;
		if (i > 0) {
			// mid-line only after , ; : ("Legend: A …") or when the series continues
			const prev = tokens[i - 1]!.t;
			const last = starts[starts.length - 1];
			const continues = last !== undefined && last.kind === pm.kind && last.value === pm.value - 1;
			if (!(/[,;:]$/.test(prev) || continues)) return;
		}
		starts.push({ i, kind: pm.kind, value: pm.value, rest: pm.rest });
	});
	const out: Entry[] = [];
	starts.forEach((st, k) => {
		const j = k + 1 < starts.length ? starts[k + 1]!.i : tokens.length;
		let name = tokens.slice(st.i + 1, j);
		while (name.length > 0 && SEPS.has(name[0]!.t)) name = name.slice(1);
		const marker = tokens[st.i]!;
		if (st.rest) {
			// "1.Aorta": the name is the right part of the marker token
			const frac = (marker.t.length - st.rest.length) / Math.max(marker.t.length, 1);
			name = [{ t: st.rest, b: [marker.b[0] + (marker.b[2] - marker.b[0]) * frac, marker.b[1], marker.b[2], marker.b[3]] }, ...name];
		}
		if (name.length === 0) return;
		const text = name.map((t) => t.t).join(" ").replace(/^[ ,;]+|[ ,;]+$/g, "");
		const words = text.split(/\s+/).filter(Boolean);
		if ((text.match(/\p{L}/gu) ?? []).length < 2 || words.length > MAX_NAME_WORDS || text.length > MAX_NAME_CHARS) return;
		out.push({ kind: st.kind, value: st.value, marker: marker.t, text, line: line.id, bbox: union(name.map((t) => t.b)) });
	});
	return out;
}

/** Consecutive markers (1,2,3… or A,B,C…) that sit together are legend candidates. */
function findRuns(entries: readonly Entry[]): Entry[][] {
	const runs: Entry[][] = [];
	for (const kind of ["n", "U", "l"] as const) {
		const byVal = new Map<number, Entry[]>();
		for (const e of entries) if (e.kind === kind) byVal.set(e.value, [...(byVal.get(e.value) ?? []), e]);
		let cur: Entry[] = [];
		for (const val of [...byVal.keys()].sort((a, b) => a - b)) {
			const cands = byVal.get(val)!;
			const last = cur[cur.length - 1];
			if (last && val === last.value + 1) {
				const nxt = cands.reduce((best, e) => (dist(e, last) < dist(best, last) ? e : best));
				if (dist(nxt, last) <= MAX_STEP) {
					cur.push(nxt);
					continue;
				}
			}
			if (cur.length >= MIN_ENTRIES) runs.push(cur);
			cur = [cands[0]!];
		}
		if (cur.length >= MIN_ENTRIES) runs.push(cur);
	}
	return runs
		.map((run) => run.slice(0, MAX_ENTRIES))
		.filter((run) => {
			const bb = union(run.map((e) => e.bbox));
			const meanWords = run.reduce((n, e) => n + e.text.split(/\s+/).length, 0) / run.length;
			return bb[2] - bb[0] <= 0.75 && bb[3] - bb[1] <= 0.7 && meanWords <= MAX_MEAN_WORDS;
		});
}

// ─── colour-swatch legends (pixel check) ─────────────────────────────────────

/** Is there a small filled colour field to the left of the text box? */
export function swatchLeft(img: Raster, bbox: readonly number[]): boolean {
	const iw = img.width;
	const ih = img.height;
	const lh = (bbox[3]! - bbox[1]!) * ih;
	if (lh < 6) return false;
	const top = Math.trunc(bbox[1]! * ih + lh * 0.15);
	const bot = Math.trunc(bbox[3]! * ih - lh * 0.15);
	const right = Math.trunc(bbox[0]! * iw) - 1;
	const left = Math.max(0, right - Math.trunc(Math.max(lh * 4, 0.05 * iw)));
	if (right - left < 4 || bot - top < 3) return false;
	const cw = right - left;
	const chh = bot - top;
	// ink = any channel darker than 225
	const ink = new Uint8Array(cw * chh);
	for (let y = 0; y < chh; y++) {
		for (let x = 0; x < cw; x++) {
			const o = ((top + y) * iw + (left + x)) * 4;
			if (Math.min(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!) < 225) ink[y * cw + x] = 1;
		}
	}
	const col = (x: number) => {
		for (let y = 0; y < chh; y++) if (ink[y * cw + x]) return true;
		return false;
	};
	let x = cw - 1;
	const gapMax = Math.trunc(lh * 1.6);
	while (x >= 0 && !col(x) && cw - 1 - x <= gapMax) x--;
	if (x < 0 || !col(x)) return false;
	const c1 = x;
	let holes = 0;
	while (x >= 0 && (col(x) || holes < 2)) {
		holes = col(x) ? 0 : holes + 1;
		x--;
	}
	const c0 = x + 1 + holes;
	const bw = c1 - c0 + 1;
	if (!(lh * 0.45 <= bw && bw <= lh * 3.5)) return false;
	let minY = Infinity;
	let maxY = -Infinity;
	let filled = 0;
	for (let y = 0; y < chh; y++) {
		for (let cx = c0; cx <= c1; cx++) {
			if (ink[y * cw + cx]) {
				filled++;
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y + 1);
			}
		}
	}
	if (filled === 0) return false;
	const bh = maxY - minY;
	if (bh < lh * 0.45) return false;
	return filled / (bw * bh) >= 0.7; // filled (no arrow, guide line or text)
}

/** Short text lines near a figure with a swatch in front; three or more together are a colour legend. */
function swatchRuns(lines: readonly PageLine[], used: ReadonlySet<string>, img: Raster, figures: readonly PageFigure[]): Entry[][] {
	const cands: Entry[] = [];
	for (const ln of lines) {
		if (used.has(ln.id) || ln.src === "legend") continue;
		const words = ln.text.split(/\s+/).filter(Boolean);
		if (!(words.length >= 1 && words.length <= 6) || ln.text.length > 45 || (ln.text.match(/\p{L}/gu) ?? []).length < 3) continue;
		if (!figures.some((f) => gap(ln.bbox, f.bbox) <= SWATCH_GAP)) continue;
		if (swatchLeft(img, ln.bbox)) cands.push({ kind: "swatch", value: 0, marker: "■", text: ln.text.replace(/^[ ,;]+|[ ,;]+$/g, ""), line: ln.id, bbox: [...ln.bbox] as Box });
	}
	const parent = cands.map((_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]!]!;
			i = parent[i]!;
		}
		return i;
	};
	for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) if (dist(cands[i]!, cands[j]!) <= 0.2) parent[find(i)] = find(j);
	const groups = new Map<number, Entry[]>();
	cands.forEach((c, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), c]));
	return [...groups.values()]
		.filter((g) => g.length >= MIN_ENTRIES)
		.map((g) => [...g].sort((a, b) => round2(a.bbox[1]) - round2(b.bbox[1]) || a.bbox[0] - b.bbox[0]).slice(0, MAX_ENTRIES));
}

const round2 = (v: number) => Math.round(v * 100) / 100;

// ─── figure for a legend ─────────────────────────────────────────────────────

interface Page {
	widthPt: number;
	heightPt: number;
	drawings: readonly Rect[];
}

function clipRect(r: Rect, W: number, H: number): Rect | null {
	const c: Rect = [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(W, r[2]), Math.min(H, r[3])];
	return c[2] > c[0] && c[3] > c[1] ? c : null;
}

/** No figure found beside the legend (e.g. a diagram of many little boxes): look for a vector cluster with a generous tolerance. */
function fallbackFigure(page: Page, legendBox: Box, existing: readonly PageFigure[]): PageFigure | null {
	const { widthPt: W, heightPt: H } = page;
	let best: { gap: number; box: Box } | null = null;
	for (const cluster of clusterRects(page.drawings, 45)) {
		const r = clipRect(cluster, W, H);
		if (!r) continue;
		const area = (r[2] - r[0]) * (r[3] - r[1]);
		if (area < 0.02 * W * H || area > 0.85 * W * H) continue;
		const b = normRect(r, W, H);
		if (overlapRatio(b, legendBox) > 0.5 && (b[2] - b[0]) * (b[3] - b[1]) <= 1.4 * (legendBox[2] - legendBox[0]) * (legendBox[3] - legendBox[1])) continue; // just the legend itself
		const g = gap(b, legendBox);
		if (g <= MAX_GAP && (best === null || g < best.gap)) best = { gap: g, box: b };
	}
	return best ? { id: `F${existing.length + 1}`, kind: "vector", bbox: best.box } : null;
}

function countMarkersInFigure(lines: readonly PageLine[], figBox: Box, run: readonly Entry[]): number {
	if (run[0]!.kind === "swatch") return 0;
	const wanted = new Set(run.map((e) => e.value));
	let n = 0;
	for (const ln of lines) {
		if (ln.src === "legend" || ln.legend) continue;
		const [cx, cy] = center(ln.bbox);
		if (!(figBox[0] <= cx && cx <= figBox[2] && figBox[1] <= cy && cy <= figBox[3])) continue;
		const pm = parseMarker(ln.text.trim());
		if (pm && pm.kind === run[0]!.kind && wanted.has(pm.value) && !pm.rest) n++;
	}
	return n;
}

/** The figure that fits the legend and how many legend markers stand in it: near enough, OR markers in the picture. */
function pickFigure(run: readonly Entry[], bb: Box, figures: readonly PageFigure[], lines: readonly PageLine[]): { fig: PageFigure; markers: number } | null {
	let best: { gap: number; fig: PageFigure; markers: number } | null = null;
	for (const f of figures) {
		const g = gap(bb, f.bbox);
		const m = countMarkersInFigure(lines, f.bbox, run);
		const ok = g <= MAX_GAP || (run[0]!.kind === "swatch" && g <= SWATCH_GAP) || (m >= 2 && g <= FAR_GAP);
		if (ok && (best === null || g < best.gap)) best = { gap: g, fig: f, markers: m };
	}
	return best ? { fig: best.fig, markers: best.markers } : null;
}

/** Vector diagrams made of separate parts: normal detection drops the far ones (a cut-off picture). All drawing clusters (coarse tolerance) touching the box belong to the figure. */
function growVectorFigure(page: Page, fig: PageFigure): void {
	const { widthPt: W, heightPt: H } = page;
	const boxes: Box[] = [fig.bbox];
	for (const cluster of clusterRects(page.drawings, 45)) {
		const r = clipRect(cluster, W, H);
		if (!r || (r[2] - r[0]) * (r[3] - r[1]) > 0.85 * W * H) continue;
		const b = normRect(r, W, H);
		if (overlapRatio(b, fig.bbox) > 0) boxes.push(b);
	}
	fig.bbox = union(boxes).map(round4) as Box;
}

// ─── the page ────────────────────────────────────────────────────────────────

/** Tokens of a line: its words if they spell the line, else spread over the line box. */
function tokensOf(line: PageLine): Token[] {
	const words = line.words;
	if (words && words.length > 0 && words.map((w: PageWord) => w.t).join(" ") === line.text) return words.map((w) => ({ t: w.t, b: [...w.b] as Box }));
	return proportionalTokens(line.text, line.bbox);
}

export interface LegendContext {
	widthPt: number;
	heightPt: number;
	drawings: readonly Rect[];
	/** The page rendered at 1.5× for the swatch check; without it only numbered / lettered legends are found. */
	raster?: Raster;
}

/** The layout with its legends found (a new object; the input is left alone). */
export function annotateLegends(input: PageLayout, ctx: LegendContext): PageLayout {
	const layout: PageLayout = structuredClone(input);
	if (layout.legends.length > 0 || layout.lines.length === 0) return layout;
	const { lines, figures } = layout;

	const entries: Entry[] = [];
	for (const ln of lines) {
		if (ln.src === "legend") continue;
		entries.push(...entriesInLine(tokensOf(ln), ln));
	}

	const runs = findRuns(entries);
	const used = new Set(runs.flatMap((r) => r.map((e) => e.line)));
	if (ctx.raster && figures.length > 0) runs.push(...swatchRuns(lines, used, ctx.raster, figures));

	let nG = 0;
	for (const run of runs) {
		const bb = union(run.map((e) => e.bbox));
		let picked = pickFigure(run, bb, figures, lines);
		if (!picked) {
			const fallback = fallbackFigure(ctx, bb, figures);
			if (!fallback) continue; // no figure near: an ordinary list, not a legend
			figures.push(fallback);
			picked = { fig: fallback, markers: countMarkersInFigure(lines, fallback.bbox, run) };
		}
		const { fig, markers } = picked;
		const legendId = `LG${layout.legends.length + 1}`;
		const kind = KIND_LABEL[run[0]!.kind];
		const ids: string[] = [];
		for (const e of [...run].sort((a, b) => a.value - b.value || a.bbox[1] - b.bbox[1])) {
			const id = `G${++nG}`;
			ids.push(id);
			lines.push({
				id,
				text: e.text,
				bbox: e.bbox.map(round4) as Box,
				tight: null,
				size: 0,
				src: "legend",
				bold: false,
				italic: false,
				underline: false,
				inFigure: false,
				marker: e.marker,
				legend: legendId,
				line: e.line,
			});
		}
		const parentIds = new Set(run.map((e) => e.line));
		const parents = lines.filter((ln) => parentIds.has(ln.id));
		for (const ln of parents) ln.legend = legendId;
		// the figure box covers figure AND legend: whole legend lines with their number / "Legend:" lead-in,
		// a little margin (colour swatches stand left of the text, outside the line box)
		const ext = union([bb, ...parents.map((l) => l.bbox)]);
		const left = kind === "swatch" ? 0.06 : 0.015;
		const grown: Box = [Math.max(0, ext[0] - left), Math.max(0, ext[1] - 0.01), Math.min(1, ext[2] + 0.015), Math.min(1, ext[3] + 0.01)];
		if (fig.kind === "vector" && !fig.legends?.length) growVectorFigure(ctx, fig);
		fig.bbox = union([fig.bbox, grown]).map(round4) as Box;
		fig.legends = [...(fig.legends ?? []), legendId];
		const legend: PageLegend = {
			id: legendId,
			kind,
			figure: fig.id,
			bbox: bb.map(round4) as Box,
			entries: ids,
			markersInFigure: markers,
			confident: kind === "swatch" || markers >= 2,
		};
		layout.legends.push(legend);
	}
	figures.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
	for (const ln of lines) ln.inFigure = figures.some((f) => centerIn(ln.bbox, f.bbox));
	return layout;
}
