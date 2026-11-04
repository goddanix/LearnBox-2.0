/**
 * pdfjs → RawPage (Learnbox 2.0, 2026-11): the one place that knows pdfjs's
 * shapes. Text runs with their font names (read from the page's font objects,
 * which only exist once the operator list has been parsed), placed images and
 * painted paths — all moved into the viewport's frame (points, origin top
 * left) so src/core/page-layout.ts never sees PDF space or page rotation.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { annotateLegends } from "../../core/legend.ts";
import { extractLayout, ocrRegions, withOcrLines } from "../../core/page-layout.ts";
import type { PageLayout, RawPage, RawTextItem, Rect } from "../../core/contracts/page-layout.ts";
import { standardFontsDir } from "../subagents/pdf-ops.ts";
import { renderPageRaster, renderPageRegion, rasterToPng, type PaintablePage } from "./render.ts";
import { ocrLinesOnPage, recognizeImage, visionAvailable } from "./vision.ts";

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 applied after m2 (pdfjs's Util.transform). */
function mul(m1: Matrix, m2: Matrix): Matrix {
	return [
		m1[0] * m2[0] + m1[2] * m2[1],
		m1[1] * m2[0] + m1[3] * m2[1],
		m1[0] * m2[2] + m1[2] * m2[3],
		m1[1] * m2[2] + m1[3] * m2[3],
		m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
		m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
	];
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function boundsOf(points: [number, number][]): Rect {
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The slice of pdfjs's page proxy this reader uses. */
export interface PdfjsPage {
	getViewport(opts: { scale: number }): { width: number; height: number; transform: number[] };
	getTextContent(): Promise<{
		items: unknown[];
		styles: Record<string, { ascent?: number; descent?: number }>;
	}>;
	getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
	commonObjs: { has(id: string): boolean; get(id: string): unknown };
}

interface TextItemLike {
	str?: unknown;
	width?: unknown;
	transform?: unknown;
	fontName?: unknown;
}

const isMatrix = (v: unknown): v is Matrix => Array.isArray(v) && v.length === 6 && v.every((n) => typeof n === "number");

function fontNameOf(page: PdfjsPage, loadedName: string, cache: Map<string, string>): string {
	const hit = cache.get(loadedName);
	if (hit !== undefined) return hit;
	let name = "";
	try {
		if (page.commonObjs.has(loadedName)) {
			const font = page.commonObjs.get(loadedName) as { name?: unknown } | null;
			if (typeof font?.name === "string") name = font.name;
		}
	} catch {
		// an unresolved font object: the name stays empty (no emphasis from the name)
	}
	cache.set(loadedName, name);
	return name;
}

function textItems(page: PdfjsPage, content: Awaited<ReturnType<PdfjsPage["getTextContent"]>>, vp: Matrix): RawTextItem[] {
	const fonts = new Map<string, string>();
	const out: RawTextItem[] = [];
	for (const raw of content.items as TextItemLike[]) {
		if (typeof raw.str !== "string" || !isMatrix(raw.transform) || typeof raw.width !== "number") continue;
		const m = mul(vp, raw.transform);
		const dir = Math.hypot(m[0], m[1]);
		const size = Math.hypot(m[2], m[3]);
		if (dir === 0 || size === 0) continue;
		const loaded = typeof raw.fontName === "string" ? raw.fontName : "";
		const style = content.styles[loaded];
		const ascent = typeof style?.ascent === "number" ? Math.abs(style.ascent) : 0;
		const descent = typeof style?.descent === "number" ? -Math.abs(style.descent) : 0;
		const horizontal = Math.abs(m[1]) <= 0.05 * dir && m[0] > 0;
		const ux = m[0] / dir;
		const uy = m[1] / dir;
		const x1 = m[4] + ux * raw.width;
		const rect: Rect = horizontal
			? [m[4], m[5] - (ascent > 0 ? ascent : 0.8) * size, x1, m[5] - (descent < 0 ? descent : -0.2) * size]
			: boundsOf([
					[m[4], m[5]],
					[m[4] + ux * raw.width, m[5] + uy * raw.width],
					[m[4] + m[2], m[5] + m[3]],
					[m[4] + ux * raw.width + m[2], m[5] + uy * raw.width + m[3]],
				]);
		out.push({
			str: raw.str,
			x: m[4],
			x1,
			baseline: m[5],
			size,
			ascent,
			descent,
			font: fontNameOf(page, loaded, fonts),
			horizontal,
			rect,
		});
	}
	return out;
}

// ─── operator list: images, painted paths, rules ─────────────────────────────

/** Path data commands (pdfjs DrawOPS): moveTo 0, lineTo 1, curveTo 2 (+6 numbers), quadraticCurveTo 3 (+4), closePath 4. */
const MOVE = 0;
const LINE = 1;
const CURVE = 2;
const QUAD = 3;
const CLOSE = 4;

/** One subpath in viewport points: a command per point (CLOSE has none, so `cmds` can be longer than `pts`). */
type Subpath = { cmds: number[]; pts: [number, number][] };

function subpaths(data: ArrayLike<number>, m: Matrix): Subpath[] {
	const subs: Subpath[] = [];
	let cur: Subpath | null = null;
	for (let i = 0; i < data.length; ) {
		const cmd = data[i++]!;
		if (cmd === MOVE) {
			cur = { cmds: [MOVE], pts: [apply(m, data[i]!, data[i + 1]!)] };
			subs.push(cur);
			i += 2;
		} else if (cmd === LINE) {
			cur?.cmds.push(LINE);
			cur?.pts.push(apply(m, data[i]!, data[i + 1]!));
			i += 2;
		} else if (cmd === CURVE) {
			cur?.cmds.push(CURVE);
			cur?.pts.push(apply(m, data[i + 4]!, data[i + 5]!));
			i += 6;
		} else if (cmd === QUAD) {
			cur?.cmds.push(QUAD);
			cur?.pts.push(apply(m, data[i + 2]!, data[i + 3]!));
			i += 4;
		} else if (cmd === CLOSE) {
			// the path may be reused for the next subpath without a new moveTo; nothing to record
		} else {
			break; // unknown command: stop rather than misread the rest
		}
	}
	return subs;
}

/**
 * PyMuPDF reports an axis-aligned four-corner path as one rectangle item and every other straight
 * segment as a line item; of those only thin, wide ones are rules (underline candidates).
 */
function rulesOf(sub: Subpath): Rect[] {
	const [p0, p1, p2, p3] = sub.pts;
	const lines = sub.cmds.filter((c) => c === LINE).length;
	if (lines === 3 && sub.pts.length === 4 && p0 && p1 && p2 && p3 && isBox(p0, p1, p2, p3)) {
		const r = boundsOf(sub.pts);
		return r[3] - r[1] <= 1.6 && r[2] - r[0] >= 3 ? [r] : [];
	}
	const out: Rect[] = [];
	for (let i = 1; i < sub.pts.length; i++) {
		const a = sub.pts[i - 1]!;
		const b = sub.pts[i]!;
		if (sub.cmds[i] === LINE && Math.abs(a[1] - b[1]) <= 0.8 && Math.abs(a[0] - b[0]) >= 3) {
			out.push([Math.min(a[0], b[0]), Math.min(a[1], b[1]) - 0.6, Math.max(a[0], b[0]), Math.max(a[1], b[1]) + 0.6]);
		}
	}
	return out;
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;

function isBox(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
	return (near(a[1], b[1]) && near(b[0], c[0]) && near(c[1], d[1]) && near(d[0], a[0])) || (near(a[0], b[0]) && near(b[1], c[1]) && near(c[0], d[0]) && near(d[1], a[1]));
}

function operators(ops: { fnArray: number[]; argsArray: unknown[] }, OPS: Record<string, number>, vp: Matrix): Pick<RawPage, "images" | "drawings" | "rules"> {
	const images: Rect[] = [];
	const drawings: Rect[] = [];
	const rules: Rect[] = [];
	const painted = new Set(
		["fill", "eoFill", "stroke", "closeStroke", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"]
			.map((n) => OPS[n])
			.filter((n): n is number => typeof n === "number"),
	);
	const imageOps = new Set(
		["paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject", "paintInlineImageXObjectGroup", "paintImageMaskXObjectGroup"]
			.map((n) => OPS[n])
			.filter((n): n is number => typeof n === "number"),
	);
	let ctm: Matrix = IDENTITY;
	const stack: Matrix[] = [];
	const unitSquare = (m: Matrix) => boundsOf([apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)]);

	for (let i = 0; i < ops.fnArray.length; i++) {
		const fn = ops.fnArray[i]!;
		const args = ops.argsArray[i];
		if (fn === OPS.save) stack.push(ctm);
		else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
		else if (fn === OPS.transform && isMatrix(args)) ctm = mul(ctm, args);
		else if (fn === OPS.paintFormXObjectBegin) {
			stack.push(ctm);
			const matrix = Array.isArray(args) ? args[0] : null;
			if (isMatrix(matrix)) ctm = mul(ctm, matrix);
		} else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
		else if (imageOps.has(fn)) images.push(unitSquare(mul(vp, ctm)));
		else if (fn === OPS.paintImageXObjectRepeat && Array.isArray(args)) {
			const [, sx, sy, positions] = args as [unknown, number, number, ArrayLike<number>];
			for (let k = 0; k + 1 < (positions?.length ?? 0); k += 2) images.push(unitSquare(mul(vp, mul(ctm, [sx, 0, 0, sy, positions[k]!, positions[k + 1]!]))));
		} else if (fn === OPS.constructPath && Array.isArray(args) && typeof args[0] === "number" && painted.has(args[0])) {
			const data = Array.isArray(args[1]) ? (args[1][0] as ArrayLike<number> | undefined) : undefined;
			if (!data) continue;
			const subs = subpaths(data, mul(vp, ctm));
			const all = subs.flatMap((s) => s.pts);
			if (all.length === 0) continue;
			drawings.push(boundsOf(all));
			for (const s of subs) rules.push(...rulesOf(s));
		}
	}
	return { images, drawings, rules };
}

/** One page as the rules see it. */
export async function readRawPage(page: PdfjsPage, OPS: Record<string, number>): Promise<RawPage> {
	const viewport = page.getViewport({ scale: 1 });
	const vp = viewport.transform as Matrix;
	// the operator list first: it loads the font objects the text items name
	const ops = await page.getOperatorList();
	const content = await page.getTextContent();
	return {
		widthPt: viewport.width,
		heightPt: viewport.height,
		items: textItems(page, content, vp),
		...operators(ops, OPS, vp),
	};
}

/** OCR lines for the regions that need them, added to the layout; a failing helper leaves the layout as it was. */
async function withOcr(page: PaintablePage, layout: PageLayout): Promise<PageLayout> {
	const regions = ocrRegions(layout);
	if (regions.length === 0) return layout;
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-ocr-"));
	try {
		const found = [];
		for (const region of regions) {
			const file = path.join(dir, "region.png");
			await fs.writeFile(file, await rasterToPng(await renderPageRegion(page, region)));
			found.push(...ocrLinesOnPage(await recognizeImage(file), region));
		}
		return withOcrLines(layout, found);
	} catch {
		return layout;
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

export interface LayoutOptions {
	/** Read text that exists only as picture (scans, labels inside raster figures) with Apple Vision. Default: when available. */
	ocr?: boolean;
	/** Find legends beside figures (needs the page painted once, for the colour-swatch check). Default true. */
	legends?: boolean;
}

/** Layouts of some pages (1-based) of a PDF file; pages out of range are left out. */
export async function pdfLayouts(filePath: string, pages: readonly number[], opts: LayoutOptions = {}): Promise<Map<number, PageLayout>> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const data = new Uint8Array(await fs.readFile(filePath));
	const task = pdfjs.getDocument({ data, standardFontDataUrl: standardFontsDir(), verbosity: 0 });
	const out = new Map<number, PageLayout>();
	try {
		const doc = await task.promise;
		for (const n of pages) {
			if (n < 1 || n > doc.numPages) continue;
			const page = (await doc.getPage(n)) as unknown as PdfjsPage & PaintablePage;
			const raw = await readRawPage(page, pdfjs.OPS as unknown as Record<string, number>);
			let layout = extractLayout(raw);
			if (opts.ocr ?? visionAvailable()) layout = await withOcr(page, layout);
			if (opts.legends !== false) {
				try {
					// legends are a heuristic and must never cost the page its layout
					const raster = layout.figures.length > 0 ? await renderPageRaster(page, 1.5) : undefined;
					layout = annotateLegends(layout, { widthPt: raw.widthPt, heightPt: raw.heightPt, drawings: raw.drawings, ...(raster ? { raster } : {}) });
				} catch {
					// keep the layout without legends
				}
			}
			out.set(n, layout);
		}
	} finally {
		await task.destroy();
	}
	return out;
}
