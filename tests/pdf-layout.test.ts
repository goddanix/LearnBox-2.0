/**
 * PDF → page layout (src/agent/layout/pdf-raw.ts): the pdfjs side, on a small hand-built PDF —
 * text in two fonts, an underline bar, a filled vector shape and an inline image.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { pdfLayouts } from "../src/agent/layout/pdf-raw.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-layout-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** US Letter, no xref table (pdfjs rebuilds it). */
function layoutPdf(): string {
	const content = [
		"BT /F1 12 Tf 50 740 Td (Plain words on a line) Tj ET",
		"BT /F2 12 Tf 50 700 Td (Bold words on a line) Tj ET",
		"BT /F1 12 Tf 50 660 Td (Underlined words here) Tj ET",
		"50 657 140 0.8 re f",
		"0.8 0.2 0.2 rg 300 300 200 150 re f",
		"q 200 0 0 150 100 100 cm BI /W 2 /H 2 /CS /G /BPC 8 /F /AHx ID 00FFFF00> EI Q",
	].join("\n");
	const objects = [
		"<</Type/Catalog/Pages 2 0 R>>",
		"<</Type/Pages/Kids[3 0 R]/Count 1>>",
		"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R/F2 5 0 R>>>>/Contents 6 0 R>>",
		"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
		"<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>",
		`<</Length ${content.length}>>\nstream\n${content}\nendstream`,
	];
	const body = objects.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join("");
	return `%PDF-1.4\n${body}trailer\n<</Root 1 0 R/Size ${objects.length + 1}>>\nstartxref\n0\n%%EOF\n`;
}

const file = path.join(root, "layout.pdf");
fs.writeFileSync(file, layoutPdf());

const near = (got: readonly number[], want: readonly number[], tol = 0.004) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]!) <= tol, `${JSON.stringify(got)} vs ${JSON.stringify(want)}`));

describe("pdfLayouts", () => {
	it("reads lines with emphasis, boxes and words from the text layer", async () => {
		const layouts = await pdfLayouts(file, [1], { ocr: false, legends: false });
		const layout = layouts.get(1)!;
		assert.equal(layout.widthPt, 612);
		assert.equal(layout.heightPt, 792);
		assert.deepEqual(layout.lines.map((l) => l.text), ["Plain words on a line", "Bold words on a line", "Underlined words here"]);
		assert.deepEqual(layout.lines.map((l) => l.bold), [false, true, false]);
		assert.deepEqual(layout.lines.map((l) => l.underline), [false, false, true]);
		assert.deepEqual(layout.lines.map((l) => l.size), [12, 12, 12]);
		const first = layout.lines[0]!;
		near(first.bbox, [50 / 612, (792 - 740 - 0.8 * 12) / 792, 50 / 612 + 0.23, (792 - 740 + 0.25 * 12) / 792], 0.1);
		assert.ok(first.bbox[0] > 0.08 && first.bbox[0] < 0.083, "starts at x = 50 pt");
		assert.ok(first.tight && first.tight[3] > first.tight[1]);
		assert.deepEqual(first.words!.map((w) => w.t), ["Plain", "words", "on", "a", "line"]);
		assert.equal(layout.title, "Plain words on a line", "equal sizes: the topmost line");
	});

	it("finds the filled shape as a vector figure and the inline image as a raster figure", async () => {
		const layout = (await pdfLayouts(file, [1], { ocr: false, legends: false })).get(1)!;
		assert.deepEqual(layout.figures.map((f) => [f.id, f.kind]), [["F1", "vector"], ["F2", "raster"]]);
		near(layout.figures[0]!.bbox, [300 / 612, (792 - 450) / 792, 500 / 612, (792 - 300) / 792]);
		near(layout.figures[1]!.bbox, [100 / 612, (792 - 250) / 792, 300 / 612, (792 - 100) / 792]);
		assert.ok(layout.lines.every((l) => !l.inFigure));
	});

	it("runs the legend step by default without disturbing a page that has none", async () => {
		const plain = (await pdfLayouts(file, [1], { ocr: false, legends: false })).get(1)!;
		const withLegends = (await pdfLayouts(file, [1], { ocr: false })).get(1)!;
		assert.deepEqual(withLegends, plain);
		assert.deepEqual(withLegends.legends, []);
	});

	it("leaves out pages that do not exist", async () => {
		const layouts = await pdfLayouts(file, [0, 1, 2], { ocr: false, legends: false });
		assert.deepEqual([...layouts.keys()], [1]);
	});
});
