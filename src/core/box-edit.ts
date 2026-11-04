/**
 * Drawing and dragging boxes on a page picture (Learnbox 2.0, 2026-11, the focus screen). Pure geometry in
 * page-normalised coordinates (0–1, [x0, y0, x1, y1]); the screen turns pointer positions into these.
 */

import type { Box } from "./contracts/page-layout.ts";

export type { Box };

/** The eight handles around a box, named by compass point. */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** The smallest a box may become, so a handle can never fold it flat. */
export const MIN_SIDE = 0.005;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** The box spanned by two points (any corner order), kept on the page. */
export function boxBetween(a: readonly [number, number], b: readonly [number, number]): Box {
	const [x0, x1] = [clamp01(a[0]), clamp01(b[0])].sort((p, q) => p - q) as [number, number];
	const [y0, y1] = [clamp01(a[1]), clamp01(b[1])].sort((p, q) => p - q) as [number, number];
	return [x0, y0, x1, y1];
}

/** Is the box big enough to have been drawn on purpose (not a click)? */
export const isDrawn = (box: Box): boolean => box[2] - box[0] >= MIN_SIDE && box[3] - box[1] >= MIN_SIDE;

/** The box after its whole body was dragged by (dx, dy): it keeps its size and stays on the page. */
export function moveBox(box: Box, dx: number, dy: number): Box {
	const w = box[2] - box[0];
	const h = box[3] - box[1];
	const x0 = Math.min(1 - w, Math.max(0, box[0] + dx));
	const y0 = Math.min(1 - h, Math.max(0, box[1] + dy));
	return [x0, y0, x0 + w, y0 + h];
}

/** The box after one handle was dragged by (dx, dy); the opposite sides stay, nothing goes off the page or below MIN_SIDE. */
export function resizeBox(box: Box, handle: Handle, dx: number, dy: number): Box {
	let [x0, y0, x1, y1] = box;
	if (handle.includes("w")) x0 = Math.min(x1 - MIN_SIDE, Math.max(0, x0 + dx));
	if (handle.includes("e")) x1 = Math.max(x0 + MIN_SIDE, Math.min(1, x1 + dx));
	if (handle.includes("n")) y0 = Math.min(y1 - MIN_SIDE, Math.max(0, y0 + dy));
	if (handle.includes("s")) y1 = Math.max(y0 + MIN_SIDE, Math.min(1, y1 + dy));
	return [x0, y0, x1, y1];
}

/** Where a handle sits on a box (the centre of its corner or side). */
export function handlePoint(box: Box, handle: Handle): [number, number] {
	const x = handle.includes("w") ? box[0] : handle.includes("e") ? box[2] : (box[0] + box[2]) / 2;
	const y = handle.includes("n") ? box[1] : handle.includes("s") ? box[3] : (box[1] + box[3]) / 2;
	return [x, y];
}
