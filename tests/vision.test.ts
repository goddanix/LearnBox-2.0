/**
 * Text recognition helper (src/agent/layout/vision.ts): how the Swift helper's output is read, what
 * happens when it fails or is missing. The helper itself is replaced by a shell script; the real one
 * (Apple Vision) runs only with LH_TEST_VISION=1 — it needs macOS and a one-off compile.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { ocrLinesOnPage, recognizeImage, resetVisionBinary, visionAvailable } from "../src/agent/layout/vision.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vision-test-"));
const saved = process.env.LH_VISION_OCR;
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => {
	if (saved === undefined) delete process.env.LH_VISION_OCR;
	else process.env.LH_VISION_OCR = saved;
	resetVisionBinary();
});

function fakeHelper(name: string, script: string): string {
	const file = path.join(root, name);
	fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	process.env.LH_VISION_OCR = file;
	resetVisionBinary();
	return file;
}

describe("recognizeImage", () => {
	it("passes the image and the confidence floor and reads the lines, dropping malformed entries", async () => {
		const argsFile = path.join(root, "args.txt");
		fakeHelper(
			"ok.sh",
			`echo "$@" > ${argsFile}\nprintf '%s' '[{"text":"Aorta","conf":0.98,"bbox":[0.1,0.2,0.3,0.25],"words":[{"t":"Aorta","bbox":[0.1,0.2,0.3,0.25]},{"t":"bad"}]},{"text":"no box","conf":1},{"bogus":true}]'`,
		);
		assert.equal(visionAvailable(), true);
		const lines = await recognizeImage("/tmp/page.png", { minConf: 0.6 });
		assert.deepEqual(lines, [{ text: "Aorta", conf: 0.98, bbox: [0.1, 0.2, 0.3, 0.25], words: [{ t: "Aorta", b: [0.1, 0.2, 0.3, 0.25] }] }]);
		assert.equal(fs.readFileSync(argsFile, "utf8").trim(), "/tmp/page.png 0.6");
	});

	it("rejects unreadable output and a failing helper with its message", async () => {
		fakeHelper("garbage.sh", "echo 'not json'");
		await assert.rejects(recognizeImage("/tmp/x.png"), /unreadable/);
		fakeHelper("boom.sh", "echo 'cannot read image' >&2\nexit 1");
		await assert.rejects(recognizeImage("/tmp/x.png"), /Text recognition failed: cannot read image/);
	});

	it("is empty, not an error, when there is no helper", async () => {
		process.env.LH_VISION_OCR = path.join(root, "does-not-exist");
		resetVisionBinary();
		assert.equal(visionAvailable(), false);
		assert.deepEqual(await recognizeImage("/tmp/x.png"), []);
	});
});

describe("ocrLinesOnPage", () => {
	it("maps boxes found in a part of the page back onto the page and numbers the lines", () => {
		const lines = ocrLinesOnPage([{ text: "Aorta", conf: 1, bbox: [0.5, 0.5, 1, 1], words: [{ t: "Aorta", b: [0.5, 0.5, 1, 1] }] }], [0.2, 0.4, 0.6, 0.8], 3);
		assert.equal(lines.length, 1);
		const l = lines[0]!;
		assert.equal(l.id, "O3");
		assert.equal(l.src, "ocr");
		assert.deepEqual(l.bbox, [0.4, 0.6, 0.6, 0.8]);
		assert.deepEqual(l.words![0]!.b, [0.4, 0.6, 0.6, 0.8]);
		assert.equal(l.inFigure, true);
	});
});

describe("Apple Vision (real helper)", { skip: process.env.LH_TEST_VISION ? false : "set LH_TEST_VISION=1 to run (macOS, compiles the helper once)" }, () => {
	it("reads text drawn into an image, with word boxes", async () => {
		delete process.env.LH_VISION_OCR;
		resetVisionBinary();
		assert.equal(visionAvailable(), true, "swiftc compiled native/vision-ocr/main.swift");
		const { createCanvas } = await import("@napi-rs/canvas");
		const canvas = createCanvas(900, 200);
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "#fff";
		ctx.fillRect(0, 0, 900, 200);
		ctx.fillStyle = "#000";
		ctx.font = "72px Helvetica";
		ctx.fillText("Aorta ventricle", 40, 120);
		const png = path.join(root, "text.png");
		fs.writeFileSync(png, canvas.toBuffer("image/png"));
		const lines = await recognizeImage(png);
		assert.equal(lines.length, 1);
		assert.match(lines[0]!.text, /Aorta ventricle/i);
		assert.deepEqual(lines[0]!.words.map((w) => w.t.toLowerCase()), ["aorta", "ventricle"]);
		const [x0, y0, x1, y1] = lines[0]!.bbox;
		assert.ok(x0 < 0.1 && x1 > 0.6 && y0 > 0.1 && y1 < 0.9);
	});
});
