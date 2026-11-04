/**
 * Legends at a figure's edge (src/core/legend.ts): numbered / lettered / colour-swatch lists that name
 * the parts of a figure, found from a layout (and, for swatches, a rendered page).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PageLayout, Raster, RawPage, RawTextItem, Rect } from "../src/core/contracts/page-layout.ts";
import { annotateLegends, parseMarker, swatchLeft } from "../src/core/legend.ts";
import { extractLayout } from "../src/core/page-layout.ts";

const W = 600;
const H = 800;

function item(str: string, x: number, baseline: number, size = 10): RawTextItem {
	const w = str.length * 5;
	return { str, x, x1: x + w, baseline, size, ascent: 0.9, descent: -0.2, font: "Helvetica", horizontal: true, rect: [x, baseline - 9, x + w, baseline + 2] };
}

function layoutOf(items: RawTextItem[], images: Rect[] = [], drawings: Rect[] = []): { layout: PageLayout; raw: RawPage } {
	const raw: RawPage = { widthPt: W, heightPt: H, items, images, drawings, rules: [] };
	return { layout: extractLayout(raw), raw };
}

const ctxOf = (raw: RawPage, raster?: Raster) => ({ widthPt: raw.widthPt, heightPt: raw.heightPt, drawings: raw.drawings, ...(raster ? { raster } : {}) });

describe("parseMarker", () => {
	it("reads numbers, capitals, circled numbers and bracketed forms", () => {
		assert.deepEqual(parseMarker("1"), { kind: "n", value: 1, rest: "" });
		assert.deepEqual(parseMarker("12."), { kind: "n", value: 12, rest: "" });
		assert.deepEqual(parseMarker("(3)"), { kind: "n", value: 3, rest: "" });
		assert.deepEqual(parseMarker("③"), { kind: "n", value: 3, rest: "" });
		assert.deepEqual(parseMarker("B"), { kind: "U", value: 2, rest: "" });
		assert.deepEqual(parseMarker("C)"), { kind: "U", value: 3, rest: "" });
		assert.deepEqual(parseMarker("a)"), { kind: "l", value: 1, rest: "" });
	});

	it("needs punctuation for lower-case letters and refuses plain words and long numbers", () => {
		assert.equal(parseMarker("a"), null);
		assert.equal(parseMarker("123"), null);
		assert.equal(parseMarker("Aorta"), null);
		assert.equal(parseMarker("1,5"), null);
	});

	it("splits a name glued to the marker", () => {
		assert.deepEqual(parseMarker("1.Aorta"), { kind: "n", value: 1, rest: "Aorta" });
		assert.deepEqual(parseMarker("A:Epidermis"), { kind: "U", value: 1, rest: "Epidermis" });
	});
});

describe("numbered legends", () => {
	const figure: Rect = [60, 120, 300, 420];
	const markers = [item("1", 100, 180), item("2", 180, 240), item("3", 120, 320)];
	const legend = [item("1 Aorta", 330, 180), item("2 Vena cava", 330, 205), item("3 Truncus", 330, 230)];

	it("finds the legend, makes entries of the names and grows the figure to cover it", () => {
		const { layout, raw } = layoutOf([...markers, ...legend], [figure]);
		assert.equal(layout.legends.length, 0);
		const out = annotateLegends(layout, ctxOf(raw));
		assert.equal(out.legends.length, 1);
		const lg = out.legends[0]!;
		assert.equal(lg.kind, "numbered");
		assert.equal(lg.markersInFigure, 3);
		assert.equal(lg.confident, true);
		const entries = out.lines.filter((l) => l.src === "legend");
		assert.deepEqual(entries.map((l) => [l.id, l.text, l.marker]), [["G1", "Aorta", "1"], ["G2", "Vena cava", "2"], ["G3", "Truncus", "3"]]);
		assert.deepEqual(lg.entries, ["G1", "G2", "G3"]);
		assert.ok(entries.every((l) => l.legend === lg.id));
		// the name box starts after the number: right of the marker's own box
		const parent = out.lines.find((l) => l.id === entries[0]!.line)!;
		assert.ok(entries[0]!.bbox[0] > parent.bbox[0]);
		assert.equal(parent.legend, lg.id, "the source line is tagged");
		const fig = out.figures[0]!;
		assert.deepEqual(fig.legends, [lg.id]);
		assert.ok(fig.bbox[2] >= lg.bbox[2], "the figure box covers the legend");
		assert.equal(out.lines.find((l) => l.text === "1 Aorta")!.inFigure, true);
	});

	it("leaves the input untouched", () => {
		const { layout, raw } = layoutOf([...markers, ...legend], [figure]);
		const before = JSON.stringify(layout);
		annotateLegends(layout, ctxOf(raw));
		assert.equal(JSON.stringify(layout), before);
	});

	it("is not confident when the numbers are not in the figure", () => {
		const { layout, raw } = layoutOf([...legend], [figure]);
		const out = annotateLegends(layout, ctxOf(raw));
		assert.equal(out.legends.length, 1);
		assert.equal(out.legends[0]!.markersInFigure, 0);
		assert.equal(out.legends[0]!.confident, false);
	});

	it("reads several entries on one line and lettered legends", () => {
		const { layout, raw } = layoutOf([item("A Epidermis, B Dermis, C Fascia", 330, 200)], [figure]);
		const out = annotateLegends(layout, ctxOf(raw));
		assert.equal(out.legends.length, 1);
		assert.equal(out.legends[0]!.kind, "lettered");
		assert.deepEqual(out.lines.filter((l) => l.src === "legend").map((l) => l.text), ["Epidermis", "Dermis", "Fascia"]);
	});

	it("an ordinary numbered list without a figure near it is no legend", () => {
		const list = [item("1 First point of the list", 60, 100), item("2 Second point of the list", 60, 120), item("3 Third point of the list", 60, 140)];
		const { layout, raw } = layoutOf(list);
		assert.deepEqual(annotateLegends(layout, ctxOf(raw)).legends, []);
	});

	it("needs at least three consecutive markers", () => {
		const { layout, raw } = layoutOf([item("1 Aorta", 330, 180), item("2 Vena cava", 330, 205)], [figure]);
		assert.deepEqual(annotateLegends(layout, ctxOf(raw)).legends, []);
	});

	it("finds a vector diagram of its own when the legend has no figure beside it", () => {
		const parts: Rect[] = [[60, 120, 95, 155], [115, 120, 150, 155], [170, 120, 205, 155], [60, 175, 95, 210], [115, 175, 150, 210], [170, 175, 205, 210]];
		const near = [item("1 Aorta", 250, 150), item("2 Vena cava", 250, 175), item("3 Truncus", 250, 200)];
		const { layout, raw } = layoutOf(near, [], parts);
		const out = annotateLegends(layout, ctxOf(raw));
		// the boxes lie within the generous tolerance (45 pt) of one another and within 0.12 of the legend (the normal
		// figure detection drops them: each one is too small)
		assert.deepEqual(layout.figures, []);
		assert.equal(out.legends.length, 1);
		assert.equal(out.figures.length, 1);
		assert.equal(out.figures[0]!.kind, "vector");
	});
});

describe("swatch legends", () => {
	/** White page raster at 1 px per point with solid squares. */
	function raster(squares: Rect[], color = [200, 60, 60]): Raster {
		const data = new Uint8ClampedArray(W * H * 4).fill(255);
		for (const [x0, y0, x1, y1] of squares) {
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					const o = (y * W + x) * 4;
					data[o] = color[0]!;
					data[o + 1] = color[1]!;
					data[o + 2] = color[2]!;
				}
			}
		}
		return { width: W, height: H, data };
	}

	const names = [item("Muscle", 400, 200, 12), item("Bone", 400, 230, 12), item("Fat tissue", 400, 260, 12)];
	// a 10 x 10 square just left of each name (the text box is ~14 pt high)
	const squares: Rect[] = [[380, 192, 390, 202], [380, 222, 390, 232], [380, 252, 390, 262]];

	it("detects a small filled colour field left of a text box", () => {
		const { layout } = layoutOf(names);
		const r = raster(squares);
		assert.equal(swatchLeft(r, layout.lines[0]!.bbox), true);
		assert.equal(swatchLeft(raster([]), layout.lines[0]!.bbox), false, "no ink, no swatch");
	});

	it("does not take text or a thin guide line for a swatch", () => {
		const { layout } = layoutOf(names);
		assert.equal(swatchLeft(raster([[380, 199, 392, 200]]), layout.lines[0]!.bbox), false, "a thin line is not filled");
	});

	it("three swatches near a figure make a confident colour legend", () => {
		const { layout, raw } = layoutOf(names, [[60, 120, 340, 420]]);
		const out = annotateLegends(layout, ctxOf(raw, raster(squares)));
		assert.equal(out.legends.length, 1);
		assert.equal(out.legends[0]!.kind, "swatch");
		assert.equal(out.legends[0]!.confident, true);
		assert.deepEqual(out.lines.filter((l) => l.src === "legend").map((l) => [l.text, l.marker]), [["Muscle", "■"], ["Bone", "■"], ["Fat tissue", "■"]]);
	});

	it("without a page raster no colour legend is looked for", () => {
		const { layout, raw } = layoutOf(names, [[60, 120, 340, 420]]);
		assert.deepEqual(annotateLegends(layout, ctxOf(raw)).legends, []);
	});
});
