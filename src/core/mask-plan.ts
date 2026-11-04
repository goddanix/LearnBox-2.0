/**
 * Occlusion mask planning (Learnbox 2.0, 2026-11): where exactly do the masks of an image-occlusion card
 * go? The boxes a layout or a model gives are only roughly right (line boxes are taller than the glyphs,
 * model boxes are estimates), so a text mask is fitted to the INK in the picture: the tightest box around
 * what actually differs from the background, a small margin, and no two masks overlapping. Hand-drawn masks
 * stay exactly as drawn; estimated boxes around non-text targets keep their generous margin.
 *
 * Pure pixel work on a Raster; drawing the masks is the card renderer's business. A port of the planning
 * half of MedAnki's medanki/occlusion.py.
 */

import type { Box, Raster } from "./contracts/page-layout.ts";

/** Colour distance to the background (0–255) from which a pixel counts as ink. */
export const INK_THRESHOLD = 40;
/** Pixels around the text box searched for ink (glyphs that overhang the box). */
const SEARCH_SLACK_X = 2;
const SEARCH_SLACK_Y = 1;

/**
 * "text": fit to the glyphs; "exact": hand-drawn, keep as drawn; "box": a model's estimate around a
 * non-text target, keep and only pad. A boolean (the old flag) means exact / text.
 */
export type MaskMode = "text" | "exact" | "box";
export type MaskModeInput = MaskMode | boolean | undefined;

export function maskMode(m: MaskModeInput): MaskMode {
	if (typeof m === "string") return m;
	return m ? "exact" : "text";
}

type PxRect = [number, number, number, number];

const toPx = (box: readonly number[], w: number, h: number): PxRect => [Math.max(0, box[0]! * w), Math.max(0, box[1]! * h), Math.min(w, box[2]! * w), Math.min(h, box[3]! * h)];

function expand(r: PxRect, pad: number, w: number, h: number): PxRect {
	return [Math.max(0, r[0] - pad), Math.max(0, r[1] - pad), Math.min(w, r[2] + pad), Math.min(h, r[3] + pad)];
}

/** Background colour of a crop: the median of its border pixels (text sits inside, the rim is mostly empty). */
function backgroundOf(img: Raster, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
	const ring: number[][] = [[], [], []];
	const take = (x: number, y: number) => {
		const o = (y * img.width + x) * 4;
		for (let c = 0; c < 3; c++) ring[c]!.push(img.data[o + c]!);
	};
	for (let x = x0; x < x1; x++) {
		take(x, y0);
		take(x, y1 - 1);
	}
	for (let y = y0; y < y1; y++) {
		take(x0, y);
		take(x1 - 1, y);
	}
	const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
	return [med(ring[0]!), med(ring[1]!), med(ring[2]!)];
}

/** Tight box around the real glyphs inside `rect` (pixels), or null when that cannot be told (no text, a photo). */
export function inkRect(img: Raster, rect: PxRect): PxRect | null {
	const x0 = Math.max(0, Math.trunc(rect[0]) - SEARCH_SLACK_X);
	const y0 = Math.max(0, Math.trunc(rect[1]) - SEARCH_SLACK_Y);
	const x1 = Math.min(img.width, Math.trunc(rect[2] + 0.999) + SEARCH_SLACK_X);
	const y1 = Math.min(img.height, Math.trunc(rect[3] + 0.999) + SEARCH_SLACK_Y);
	const w = x1 - x0;
	const h = y1 - y0;
	if (w < 6 || h < 6) return null;
	const [br, bg, bb] = backgroundOf(img, x0, y0, x1, y1);
	const rows = new Float64Array(h);
	const cols = new Float64Array(w);
	let ink = 0;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const o = ((y0 + y) * img.width + (x0 + x)) * 4;
			const d = Math.max(Math.abs(img.data[o]! - br), Math.abs(img.data[o + 1]! - bg), Math.abs(img.data[o + 2]! - bb));
			if (d > INK_THRESHOLD) {
				ink++;
				rows[y] = (rows[y] ?? 0) + 1;
				cols[x] = (cols[x] ?? 0) + 1;
			}
		}
	}
	if (ink === 0 || ink > 0.7 * w * h) return null; // nothing found, or an area / photo instead of text on a quiet ground
	// a row or column counts when it holds ≥ 0.6 % (at least 1.5 px) ink; the 0–255 scale of the original is kept
	const byteRow = (n: number) => Math.round((255 * n) / w);
	const byteCol = (n: number) => Math.round((255 * n) / h);
	const tr = Math.max(2, Math.trunc(255 * Math.max(0.006, 1.5 / w)));
	const tc = Math.max(2, Math.trunc(255 * Math.max(0.006, 1.5 / h)));
	let yFirst = -1;
	let yLast = -1;
	for (let y = 0; y < h; y++) {
		if (byteRow(rows[y]!) < tr) continue;
		if (yFirst < 0) yFirst = y;
		yLast = y;
	}
	let xFirst = -1;
	let xLast = -1;
	for (let x = 0; x < w; x++) {
		if (byteCol(cols[x]!) < tc) continue;
		if (xFirst < 0) xFirst = x;
		xLast = x;
	}
	if (yFirst < 0 || xFirst < 0 || xLast + 1 - xFirst < 3 || yLast + 1 - yFirst < 3) return null;
	return [x0 + xFirst, y0 + yFirst, x0 + xLast + 1, y0 + yLast + 1];
}

/**
 * Pull overlapping mask rectangles apart (in place): cut halfway between the text cores, so no mask
 * reaches over another — and, in "single" mode, not over its neighbours' text.
 */
export function separateMasks(rects: PxRect[], cores: PxRect[]): void {
	const n = rects.length;
	for (let pass = 0; pass < 3; pass++) {
		let changed = false;
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				const a = rects[i]!;
				const b = rects[j]!;
				const ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
				const iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
				if (ix <= 0.5 || iy <= 0.5) continue;
				if ((a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3]) || (b[0] <= a[0] && b[1] <= a[1] && b[2] >= a[2] && b[3] >= a[3])) continue; // one mask inside the other: cannot be resolved
				const ta = cores[i]!;
				const tb = cores[j]!;
				const gx = Math.max(ta[0] - tb[2], tb[0] - ta[2]); // > 0: cores apart in x
				const gy = Math.max(ta[1] - tb[3], tb[1] - ta[3]);
				let axis: "x" | "y";
				if (gx > 0 || gy > 0) axis = gx > gy ? "x" : "y"; // cut along the axis with the larger gap
				else {
					// the cores overlap themselves: cut where the overlap is flattest
					const dx = Math.min(ta[2], tb[2]) - Math.max(ta[0], tb[0]);
					const dy = Math.min(ta[3], tb[3]) - Math.max(ta[1], tb[1]);
					axis = dx < dy ? "x" : "y";
				}
				const [lo, hi] = axis === "x" ? [0, 2] : [1, 3];
				const [first, second] = ta[lo]! + ta[hi]! <= tb[lo]! + tb[hi]! ? [i, j] : [j, i];
				const cf = cores[first]!;
				const cs = cores[second]!;
				const mid = (cf[hi]! + cs[lo]!) / 2;
				rects[first]![hi] = Math.min(rects[first]![hi]!, Math.max(mid, rects[first]![lo]! + 1));
				rects[second]![lo] = Math.max(rects[second]![lo]!, Math.min(mid, rects[second]![hi]! - 1));
				changed = true;
			}
		}
		if (!changed) break;
	}
}

export interface MaskPlan {
	/** Pixel rectangles of the target masks, in the order of `targetBoxes`. */
	targets: PxRect[];
	/** ... and of the other masks (the ones that stay as context), in the order of `otherBoxes`. */
	others: PxRect[];
}

/**
 * Pixel rectangles for all masks of a figure. Boxes are figure-local, normalised (0..1). Text masks hug the
 * glyphs (+ a small margin) and do not overlap; "exact" masks stay as drawn, "box" masks keep their generous
 * margin — for those two only real overlaps with other masks are separated.
 */
export function planMasks(
	base: Raster,
	targetBoxes: readonly Box[],
	otherBoxes: readonly Box[],
	targetModes?: readonly MaskModeInput[],
	otherModes?: readonly MaskModeInput[],
): MaskPlan {
	const { width: W, height: H } = base;
	const longSide = Math.max(W, H);
	const margin = Math.max(3, 0.002 * longSide);
	const fallback = Math.max(3, 0.004 * longSide); // no ink found / estimated boxes: generous
	const items: { box: Box; mode: MaskMode }[] = [
		...targetBoxes.map((box, i) => ({ box, mode: maskMode(targetModes?.[i]) })),
		...otherBoxes.map((box, i) => ({ box, mode: maskMode(otherModes?.[i]) })),
	];
	const rects: PxRect[] = [];
	const cores: PxRect[] = [];
	for (const { box, mode } of items) {
		const raw = toPx(box, W, H);
		const ink = mode === "text" ? inkRect(base, raw) : null;
		let core: PxRect;
		let rect: PxRect;
		if (mode === "exact") {
			core = raw;
			rect = [...raw];
		} else if (ink) {
			core = ink;
			rect = expand(ink, margin, W, H);
		} else {
			core = raw;
			rect = expand(raw, fallback, W, H);
		}
		cores.push(core);
		rects.push(rect);
	}
	separateMasks(rects, cores);
	const n = targetBoxes.length;
	return { targets: rects.slice(0, n), others: rects.slice(n) };
}

/** Page-normalised box → figure-local box (0..1 within the figure's own box). */
export function toLocal(box: readonly number[], fig: readonly number[]): Box {
	const fw = fig[2]! - fig[0]!;
	const fh = fig[3]! - fig[1]!;
	return [
		Math.max(0, (box[0]! - fig[0]!) / fw),
		Math.max(0, (box[1]! - fig[1]!) / fh),
		Math.min(1, (box[2]! - fig[0]!) / fw),
		Math.min(1, (box[3]! - fig[1]!) / fh),
	];
}
