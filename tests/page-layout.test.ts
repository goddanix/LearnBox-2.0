/**
 * Page layout rules (src/core/page-layout.ts): runs of text → lines with boxes and emphasis,
 * painted shapes → figure regions, OCR merging. Pure, on hand-made RawPages.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PageLayout, RawPage, RawTextItem, Rect } from "../src/core/contracts/page-layout.ts";
import { centerIn, clusterRects, extractLayout, figureRegions, fontEmphasis, guessTitle, mergeRegions, normRect, ocrRegions, withOcrLines } from "../src/core/page-layout.ts";

const W = 600;
const H = 800;
const SIZE = 10;

/** A run of text; width is 5 pt per character unless given. */
function item(str: string, x: number, baseline: number, over: Partial<RawTextItem> = {}): RawTextItem {
	const w = over.x1 !== undefined ? over.x1 - x : str.length * 5;
	const size = over.size ?? SIZE;
	return {
		str,
		x,
		x1: x + w,
		baseline,
		size,
		ascent: 0.9,
		descent: -0.2,
		font: "Helvetica",
		horizontal: true,
		rect: [x, baseline - 0.9 * size, x + w, baseline + 0.2 * size],
		...over,
	};
}

function page(over: Partial<RawPage> = {}): RawPage {
	return { widthPt: W, heightPt: H, items: [], images: [], drawings: [], rules: [], ...over };
}

describe("lines", () => {
	it("joins runs on one baseline into a line with the words spaced", () => {
		const layout = extractLayout(page({ items: [item("Hello", 50, 100), item("world", 78, 100)] }));
		assert.equal(layout.lines.length, 1);
		assert.equal(layout.lines[0]!.text, "Hello world");
		assert.equal(layout.lines[0]!.id, "L1");
		assert.equal(layout.lines[0]!.src, "pdf");
	});

	it("does not add a space where runs touch, and keeps spaces the runs bring", () => {
		const touching = extractLayout(page({ items: [item("arti", 50, 100), item("culation", 70, 100)] }));
		assert.equal(touching.lines[0]!.text, "articulation");
		const spaced = extractLayout(page({ items: [item("is a ", 50, 100), item("joint", 75, 100)] }));
		assert.equal(spaced.lines[0]!.text, "is a joint");
	});

	it("starts a new line for another baseline, a jump back, or a wide gap (table cells)", () => {
		const two = extractLayout(page({ items: [item("one", 50, 100), item("two", 50, 115)] }));
		assert.deepEqual(two.lines.map((l) => l.text), ["one", "two"]);
		const back = extractLayout(page({ items: [item("later", 200, 100), item("earlier", 50, 100)] }));
		assert.deepEqual(back.lines.map((l) => l.text), ["later", "earlier"]);
		const cells = extractLayout(page({ items: [item("fat", 50, 100), item("1,37", 200, 100)] }));
		assert.deepEqual(cells.lines.map((l) => l.text), ["fat", "1,37"]);
	});

	it("a blank run wider than two font sizes separates cells even when the next text abuts it", () => {
		const layout = extractLayout(page({ items: [item("fat", 50, 100), item(" ", 65, 100, { x1: 165 }), item("1,37", 165, 100)] }));
		assert.deepEqual(layout.lines.map((l) => l.text), ["fat", "1,37"]);
		const bullet = extractLayout(page({ items: [item("1.", 50, 100), item(" ", 60, 100, { x1: 70 }), item("Source", 70, 100)] }));
		assert.deepEqual(bullet.lines.map((l) => l.text), ["1. Source"], "an ordinary space after a number joins");
	});

	it("keeps a raised smaller run (superscript) on the line", () => {
		const layout = extractLayout(page({ items: [item("the 3", 50, 100), item("rd", 75, 96, { size: 6 }), item(" finger", 81, 100)] }));
		assert.equal(layout.lines.length, 1);
		assert.equal(layout.lines[0]!.text, "the 3rd finger");
		assert.equal(layout.lines[0]!.size, 10);
	});

	it("whitespace at the ends of a line takes no room in the box", () => {
		const layout = extractLayout(page({ items: [item("1", 100, 100, { x1: 103 }), item(" ", 103, 100, { x1: 130 })] }));
		assert.equal(layout.lines[0]!.bbox[2], normRect([0, 0, 103, 0], W, H)[2]);
	});

	it("boxes are normalised to the page, tight box hugs baseline − 0.8·size … + 0.24·size", () => {
		const layout = extractLayout(page({ items: [item("Tight", 60, 200)] }));
		const l = layout.lines[0]!;
		assert.deepEqual(l.bbox, normRect([60, 200 - 9, 85, 200 + 2], W, H));
		assert.deepEqual(l.tight, normRect([60, 200 - 8, 85, 200 + 2], W, H));
	});

	it("rotated runs are lines of their own without a tight box", () => {
		const rotated = item("Side", 30, 300, { horizontal: false, rect: [20, 250, 32, 290] });
		const layout = extractLayout(page({ items: [rotated, item("Next", 30, 320, { horizontal: false, rect: [20, 300, 32, 340] })] }));
		assert.equal(layout.lines.length, 2);
		assert.equal(layout.lines[0]!.tight, null);
		assert.equal(layout.lines[0]!.words, undefined);
		assert.deepEqual(layout.lines[0]!.bbox, normRect([20, 250, 32, 290], W, H));
	});

	it("reads bold and italic from the font names, by share of the characters", () => {
		assert.deepEqual(fontEmphasis("ABCDEF+Calibri-BoldItalic"), { bold: true, italic: true });
		assert.deepEqual(fontEmphasis("Arial"), { bold: false, italic: false });
		assert.equal(fontEmphasis("Frutiger-SemiBold").bold, true);
		const layout = extractLayout(
			page({
				items: [
					item("Bold part", 50, 100, { font: "Calibri-Bold" }),
					item(" and plain tail words", 95, 100),
					item("All bold", 50, 130, { font: "Calibri-Bold" }),
					item(" ok", 90, 130),
				],
			}),
		);
		assert.equal(layout.lines[0]!.bold, false, "9 of 30 characters bold");
		assert.equal(layout.lines[1]!.bold, true);
		assert.equal(layout.lines[1]!.italic, false);
	});

	it("marks a line underlined when thin bars under it cover at least half its width", () => {
		const text = item("Underlined text", 50, 100, { x1: 150 });
		const bar: Rect = [50, 101.4, 130, 102.6]; // 80 of 100 pt
		const short: Rect = [50, 101.4, 80, 102.6];
		assert.equal(extractLayout(page({ items: [text], rules: [bar] })).lines[0]!.underline, true);
		assert.equal(extractLayout(page({ items: [text], rules: [short] })).lines[0]!.underline, false);
		assert.equal(extractLayout(page({ items: [text], rules: [[50, 140, 150, 141]] })).lines[0]!.underline, false, "a rule far below is no underline");
	});

	it("gives every PDF line its words, boxed by character position", () => {
		const layout = extractLayout(page({ items: [item("two words", 100, 100)] }));
		const words = layout.lines[0]!.words!;
		assert.deepEqual(words.map((w) => w.t), ["two", "words"]);
		assert.equal(words[0]!.b[0], normRect([100, 0, 0, 0], W, H)[0]);
		assert.equal(words[0]!.b[2], normRect([115, 0, 0, 0], W, H)[0]);
		assert.equal(words[1]!.b[0], normRect([120, 0, 0, 0], W, H)[0]);
		assert.equal(words[1]!.b[2], normRect([145, 0, 0, 0], W, H)[0]);
		assert.equal(words.map((w) => w.t).join(" "), layout.lines[0]!.text);
	});

	it("counts characters and guesses the title: the largest line near the top", () => {
		const layout = extractLayout(page({ items: [item("Small print here", 50, 60), item("BIG TITLE", 50, 40, { size: 24 }), item("Body text", 50, 500)] }));
		assert.equal(layout.title, "BIG TITLE");
		assert.equal(layout.chars, "Small print here".length + "BIG TITLE".length + "Body text".length);
		assert.equal(guessTitle([]), "");
	});
});

describe("figures", () => {
	const box = (x0: number, y0: number, x1: number, y1: number): Rect => [x0, y0, x1, y1];

	it("takes big images as raster figures and drops small ones", () => {
		const figs = figureRegions(page({ images: [box(100, 100, 400, 400), box(10, 10, 30, 30)] }), []);
		assert.equal(figs.length, 1);
		assert.equal(figs[0]!.kind, "raster");
		assert.equal(figs[0]!.id, "F1");
		assert.deepEqual(figs[0]!.bbox, normRect([100, 100, 400, 400], W, H));
	});

	it("clusters nearby drawings into one vector figure and ignores a page-sized background", () => {
		const drawings = [box(0, 0, W, H), box(100, 100, 200, 200), box(202, 150, 300, 260)];
		const figs = figureRegions(page({ drawings }), []);
		assert.equal(figs.length, 1);
		assert.equal(figs[0]!.kind, "vector");
		assert.deepEqual(figs[0]!.bbox, normRect([100, 100, 300, 260], W, H));
	});

	it("drops tiny leftovers (rules, frames)", () => {
		assert.deepEqual(figureRegions(page({ drawings: [box(50, 50, 400, 52), box(60, 60, 90, 90)] }), []), []);
	});

	it("figures come top to bottom, numbered", () => {
		const figs = figureRegions(page({ images: [box(50, 500, 350, 780), box(50, 50, 350, 330)] }), []);
		assert.deepEqual(figs.map((f) => [f.id, f.bbox[1]]), [["F1", normRect([0, 50, 0, 0], W, H)[1]], ["F2", normRect([0, 500, 0, 0], W, H)[1]]]);
	});

	it("a short label next to a figure belongs to it, a sentence does not", () => {
		const layout = extractLayout(
			page({
				images: [box(100, 100, 400, 400)],
				items: [item("Aorta", 405, 250), item("This is a long explanatory sentence about it", 105, 430)],
			}),
		);
		const fig = layout.figures[0]!;
		assert.ok(fig.bbox[2] > normRect([0, 0, 400, 0], W, H)[2], "the figure grew to the label");
		assert.equal(layout.lines.find((l) => l.text === "Aorta")!.inFigure, true);
		assert.equal(layout.lines.find((l) => l.text.startsWith("This is"))!.inFigure, false);
	});

	it("mergeRegions merges touching regions (raster wins) and clusterRects uses a tolerance", () => {
		const merged = mergeRegions(
			[
				{ kind: "vector" as const, bbox: [0.1, 0.1, 0.3, 0.3] as [number, number, number, number] },
				{ kind: "raster" as const, bbox: [0.31, 0.1, 0.5, 0.3] as [number, number, number, number] },
			],
			0.03,
		);
		assert.equal(merged.length, 1);
		assert.equal(merged[0]!.kind, "raster");
		assert.deepEqual(clusterRects([box(0, 0, 10, 10), box(12, 0, 20, 10), box(100, 100, 110, 110)], 3), [box(0, 0, 20, 10), box(100, 100, 110, 110)]);
		assert.equal(clusterRects([box(0, 0, 10, 10), box(20, 0, 30, 10)], 3).length, 2);
	});

	it("centerIn tests the centre of a box", () => {
		assert.equal(centerIn([0.4, 0.4, 0.5, 0.5], [0.3, 0.3, 0.6, 0.6]), true);
		assert.equal(centerIn([0.1, 0.1, 0.2, 0.2], [0.3, 0.3, 0.6, 0.6]), false);
	});
});

describe("OCR merging", () => {
	const base = (over: Partial<PageLayout> = {}): PageLayout => ({
		widthPt: W,
		heightPt: H,
		lines: [],
		figures: [],
		legends: [],
		chars: 0,
		title: "",
		...over,
	});
	const found = (text: string, bbox: [number, number, number, number]) => ({
		id: "O1",
		text,
		bbox,
		tight: null,
		size: 0,
		src: "ocr" as const,
		bold: false,
		italic: false,
		underline: false,
		inFigure: true,
	});

	it("asks for OCR of the whole page when there is hardly any text layer", () => {
		assert.deepEqual(ocrRegions(base({ chars: 5 })), [[0, 0, 1, 1]]);
	});

	it("otherwise only for raster figures with fewer than three lines of their own", () => {
		const layout = extractLayout(
			page({
				images: [box2(50, 50, 300, 300), box2(50, 400, 300, 700)],
				items: [item("a label", 60, 100), item("b label", 60, 140), item("c label", 60, 180), item("lonely", 60, 500), item("x".repeat(40), 350, 100)],
			}),
		);
		const regions = ocrRegions(layout);
		assert.equal(regions.length, 1);
		assert.deepEqual(regions[0], layout.figures[1]!.bbox);
	});

	it("adds OCR lines as O1…, skips what the text layer already covers, and recomputes the totals", () => {
		const layout = extractLayout(page({ images: [box2(100, 100, 400, 400)], items: [item("Existing text", 150, 200)] }));
		const out = withOcrLines(layout, [
			found("Existing text", layout.lines[0]!.bbox),
			found("Vena cava", [0.3, 0.4, 0.4, 0.43]),
			found("Aorta", [0.5, 0.2, 0.6, 0.23]),
		]);
		assert.deepEqual(out.lines.map((l) => [l.id, l.src]), [["L1", "pdf"], ["O1", "ocr"], ["O2", "ocr"]]);
		assert.equal(out.chars, "Existing text".length + "Vena cava".length + "Aorta".length);
		assert.equal(out.lines[1]!.inFigure, true);
		assert.equal(layout.lines.length, 1, "the input is not touched");
	});

	it("takes a title from the OCR text when the page had none", () => {
		const out = withOcrLines(base(), [found("Scanned heading", [0.1, 0.05, 0.5, 0.08]), found("lower", [0.1, 0.5, 0.2, 0.52])]);
		assert.equal(out.title, "Scanned heading");
	});
});

function box2(x0: number, y0: number, x1: number, y1: number): Rect {
	return [x0, y0, x1, y1];
}
