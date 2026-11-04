/**
 * pdfPageLines (src/agent/subagents/pdf-ops.ts): a page's text as numbered
 * lines, read from a real (tiny) PDF.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { pdfPageLines } from "../src/agent/subagents/pdf-ops.ts";
import { textPdf } from "./fixtures/text-pdf.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-lines-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(name: string, pages: string[]): string {
	const file = path.join(root, name);
	fs.writeFileSync(file, textPdf(pages));
	return file;
}

describe("pdfPageLines", () => {
	it("returns the lines of a page, numbered T001…, in reading order", async () => {
		const file = write("two.pdf", ["First line of page one. Second line is quite a bit longer than the first one so that the fixture wraps it onto a further line at eighty characters.", "Only line of page two."]);
		const one = await pdfPageLines(file, 1);
		assert.ok(one.length >= 2, `wrapped into several lines: ${JSON.stringify(one)}`);
		assert.deepEqual(one.map((l) => l.id), one.map((_, i) => `T${String(i + 1).padStart(3, "0")}`));
		assert.match(one.map((l) => l.text).join(" "), /First line of page one\. Second line is quite/);
		assert.match(one.map((l) => l.text).join(" "), /at eighty characters\./);

		assert.deepEqual(await pdfPageLines(file, 2), [{ id: "T001", text: "Only line of page two." }]);
	});

	it("is empty for a page that does not exist", async () => {
		const file = write("one.pdf", ["Hello"]);
		assert.deepEqual(await pdfPageLines(file, 0), []);
		assert.deepEqual(await pdfPageLines(file, 2), []);
	});

	it("is empty for a page without text", async () => {
		const file = write("blank.pdf", [""]);
		assert.deepEqual(await pdfPageLines(file, 1), []);
	});
});
