/**
 * Occlusion mask planning (src/core/mask-plan.ts): masks fitted to the ink, kept as drawn, or padded —
 * and never overlapping. Pure pixel work on synthetic rasters. (The planner was also checked
 * pixel-for-pixel against MedAnki's Python original on real pages — see the Slice 2 notes.)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Raster } from "../src/core/contracts/page-layout.ts";
import { inkRect, maskMode, planMasks, separateMasks, toLocal } from "../src/core/mask-plan.ts";

function blank(w: number, h: number, bg = [255, 255, 255]): Raster {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++) data.set([bg[0]!, bg[1]!, bg[2]!, 255], i * 4);
	return { width: w, height: h, data };
}

function fill(r: Raster, x0: number, y0: number, x1: number, y1: number, rgb = [0, 0, 0]): void {
	for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) r.data.set([rgb[0]!, rgb[1]!, rgb[2]!, 255], (y * r.width + x) * 4);
}

describe("inkRect", () => {
	it("fits a box to the glyphs inside a looser search rectangle", () => {
		const r = blank(200, 100);
		fill(r, 40, 30, 100, 42);
		assert.deepEqual(inkRect(r, [30, 20, 120, 52]), [40, 30, 100, 42]);
	});

	it("works on a coloured, quiet background", () => {
		const r = blank(200, 100, [250, 240, 200]);
		fill(r, 40, 30, 100, 42, [20, 20, 120]);
		assert.deepEqual(inkRect(r, [30, 20, 120, 52]), [40, 30, 100, 42]);
	});

	it("is null for no text, for a photo-like area, and for a box too small to read", () => {
		const empty = blank(200, 100);
		assert.equal(inkRect(empty, [30, 20, 120, 52]), null);
		const photo = blank(200, 100);
		fill(photo, 0, 0, 200, 100, [90, 90, 90]);
		fill(photo, 0, 0, 200, 3, [255, 255, 255]);
		assert.equal(inkRect(photo, [30, 20, 120, 52]), null);
		assert.equal(inkRect(empty, [30, 20, 33, 23]), null);
	});
});

describe("planMasks", () => {
	it("hugs the glyphs with a small margin in text mode", () => {
		const r = blank(1000, 500);
		fill(r, 400, 200, 500, 220);
		const { targets } = planMasks(r, [[0.39, 0.38, 0.52, 0.46]], []);
		const [x0, y0, x1, y1] = targets[0]!;
		assert.ok(x0 >= 396 && x0 <= 399 && x1 >= 501 && x1 <= 504, `x ${x0}..${x1}`);
		assert.ok(y0 >= 196 && y0 <= 199 && y1 >= 221 && y1 <= 224, `y ${y0}..${y1}`);
	});

	it("keeps an exact (hand-drawn) mask as drawn and pads an estimated box", () => {
		const r = blank(1000, 500);
		fill(r, 400, 200, 500, 220);
		const box: [number, number, number, number] = [0.39, 0.38, 0.52, 0.46];
		const exact = planMasks(r, [box], [], [true]).targets[0]!;
		assert.deepEqual(exact, [390, 190, 520, 230]);
		const estimated = planMasks(r, [box], [], ["box"]).targets[0]!;
		assert.ok(estimated[0] < 390 && estimated[2] > 520, "padded beyond the box");
	});

	it("falls back to the padded box when there is no ink", () => {
		const r = blank(1000, 500);
		const [t] = planMasks(r, [[0.5, 0.5, 0.6, 0.6]], []).targets;
		assert.ok(t![0] < 500 && t![1] < 250 && t![2] > 600 && t![3] > 300);
	});

	it("returns the other masks separately, in order, and never lets masks overlap", () => {
		const r = blank(400, 200);
		fill(r, 100, 80, 150, 92); // two words close together
		fill(r, 154, 80, 200, 92);
		const { targets, others } = planMasks(r, [[0.24, 0.38, 0.39, 0.47]], [[0.37, 0.38, 0.52, 0.47]]);
		assert.equal(targets.length, 1);
		assert.equal(others.length, 1);
		const [a, b] = [targets[0]!, others[0]!];
		const ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
		const iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
		assert.ok(ix <= 0.5 || iy <= 0.5, `masks overlap by ${ix} x ${iy}px`);
	});

	it("maps the legacy boolean flag to the mode", () => {
		assert.equal(maskMode(true), "exact");
		assert.equal(maskMode(false), "text");
		assert.equal(maskMode(undefined), "text");
		assert.equal(maskMode("box"), "box");
	});
});

describe("separateMasks", () => {
	it("cuts halfway between the cores of two overlapping masks", () => {
		const rects: [number, number, number, number][] = [[0, 0, 60, 20], [40, 0, 100, 20]];
		const cores: [number, number, number, number][] = [[10, 4, 50, 16], [60, 4, 90, 16]];
		separateMasks(rects, cores);
		assert.equal(rects[0]![2], 55);
		assert.equal(rects[1]![0], 55);
	});

	it("leaves a mask that lies wholly inside another alone", () => {
		const rects: [number, number, number, number][] = [[0, 0, 100, 100], [20, 20, 40, 40]];
		separateMasks(rects, [[10, 10, 90, 90], [25, 25, 35, 35]]);
		assert.deepEqual(rects, [[0, 0, 100, 100], [20, 20, 40, 40]]);
	});
});

describe("toLocal", () => {
	it("moves a page box into the figure's own 0..1 frame, clipped", () => {
		const near = (got: number[], want: number[]) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]!) < 1e-9, `${got} vs ${want}`));
		near(toLocal([0.3, 0.3, 0.5, 0.4], [0.2, 0.2, 0.6, 0.6]), [0.25, 0.25, 0.75, 0.5]);
		assert.deepEqual(toLocal([0.1, 0.1, 0.9, 0.9], [0.2, 0.2, 0.6, 0.6]), [0, 0, 1, 1]);
	});
});
