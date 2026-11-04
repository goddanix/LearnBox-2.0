/**
 * Perceptual hash of a figure (Learnbox 2.0, 2026-11): a 16×16 difference hash — 256 bits as 64 hex
 * characters — that recognises the same figure at a slightly different crop or resolution (the same slide
 * on two pages), which is how the duplicate check matches occlusions across pages (core/card-dedupe.ts).
 * Same recipe as MedAnki's occlusion.dhash (grey, 17×16 reduction, left pixel brighter than its right
 * neighbour); the reduction averages the covered source pixels instead of PIL's Lanczos, so the hashes
 * are close to MedAnki's, not identical — the comparison only ever happens between hashes made here.
 */

import type { Raster } from "./contracts/page-layout.ts";

const SIZE = 16;

/** Mean grey value of the source area behind each cell of a `cols`×`rows` grid. */
function reduce(img: Raster, cols: number, rows: number): number[] {
	const { width: W, height: H, data } = img;
	const out: number[] = [];
	for (let gy = 0; gy < rows; gy++) {
		const y0 = Math.floor((gy * H) / rows);
		const y1 = Math.max(y0 + 1, Math.ceil(((gy + 1) * H) / rows));
		for (let gx = 0; gx < cols; gx++) {
			const x0 = Math.floor((gx * W) / cols);
			const x1 = Math.max(x0 + 1, Math.ceil(((gx + 1) * W) / cols));
			let sum = 0;
			let n = 0;
			for (let y = y0; y < Math.min(y1, H); y++) {
				for (let x = x0; x < Math.min(x1, W); x++) {
					const i = (y * W + x) * 4;
					sum += (data[i]! * 299 + data[i + 1]! * 587 + data[i + 2]! * 114) / 1000;
					n++;
				}
			}
			out.push(n > 0 ? sum / n : 255);
		}
	}
	return out;
}

export function dhash(img: Raster): string {
	const grey = reduce(img, SIZE + 1, SIZE);
	let bits = "";
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) bits += grey[y * (SIZE + 1) + x]! > grey[y * (SIZE + 1) + x + 1]! ? "1" : "0";
	}
	let hex = "";
	for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
	return hex;
}
