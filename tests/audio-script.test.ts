import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SCRIPT_SYSTEM, scriptPrompt, WORDS_PER_MINUTE } from "../src/agent/create/audio-prompts.ts";
import { byteRange } from "../src/core/http-range.ts";
import { audioMaterial, clipTitle, scriptBudget, speechChars, splitSpeech, SPEECH_PIECE } from "../src/core/audio-script.ts";

// MedAnki's own output (tests/fixtures/gen-medanki-audio.py)
const fx = JSON.parse(readFileSync(new URL("./fixtures/medanki-audio.json", import.meta.url), "utf8")) as {
	scriptSystem: string;
	wordsPerMinute: number;
	prompts: { docName: string; words: number; material: string; out: string }[];
	budget: { pages: number; words: number }[];
	material: { docs: { name: string; pages: { page: number; text: string }[] }[]; out: { text: string; totalPages: number } }[];
};

describe("the audio script as MedAnki writes it", () => {
	it("keeps the length budget (700 to 2200 words, 30 more per page)", () => {
		for (const c of fx.budget) assert.equal(scriptBudget(c.pages), c.words, `${c.pages} pages`);
	});

	it("builds the material from the pages with text", () => {
		for (const c of fx.material) assert.deepEqual(audioMaterial(c.docs), c.out);
	});

	it("uses MedAnki's prompt word for word", () => {
		assert.equal(SCRIPT_SYSTEM, fx.scriptSystem);
		assert.equal(WORDS_PER_MINUTE, fx.wordsPerMinute);
		for (const c of fx.prompts) assert.equal(scriptPrompt(c.docName, c.words, c.material), c.out, `${c.docName} ${c.words}`);
	});

	it("cuts a title to 120 characters, not code units", () => {
		assert.equal(clipTitle("  Heart  "), "Heart");
		assert.equal([...clipTitle("😀".repeat(130))].length, 120);
		assert.equal(clipTitle("😀".repeat(130)), "😀".repeat(120));
	});
});

describe("cutting a script for the speech service", () => {
	const longScript = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} explains one more thing about the heart.`).join(" ");

	it("counts characters, not code units", () => {
		assert.equal(speechChars("héllo 😀"), 7);
	});

	it("leaves a short script in one piece", () => {
		assert.deepEqual(splitSpeech("One. Two! Three?"), ["One. Two! Three?"]);
		assert.deepEqual(splitSpeech("  "), []);
	});

	it("cuts after a sentence and keeps every word", () => {
		const pieces = splitSpeech(longScript, 1000);
		assert.ok(pieces.length > 1);
		for (const p of pieces) {
			assert.ok([...p].length <= 1000, `${[...p].length} characters`);
			assert.match(p, /[.!?]$/, "ends at the end of a sentence");
		}
		assert.equal(pieces.join(" "), longScript);
	});

	it("uses a piece size far below the limits of the models by default", () => {
		assert.equal(SPEECH_PIECE, 4500);
		for (const p of splitSpeech(longScript)) assert.ok([...p].length <= SPEECH_PIECE);
	});

	it("cuts a sentence that is longer than a piece at a space, and a word with no space anywhere", () => {
		const sentence = `${"word ".repeat(40)}end.`;
		const pieces = splitSpeech(sentence, 50);
		assert.ok(pieces.every((p) => [...p].length <= 50));
		assert.equal(pieces.join(" "), sentence);
		const blob = "x".repeat(130);
		assert.deepEqual(
			splitSpeech(blob, 50).map((p) => p.length),
			[50, 50, 30],
		);
	});

	it("does not split after a decimal point or an abbreviation without a following blank", () => {
		const pieces = splitSpeech("The ratio is 3.5 to 1. Next one.", 1000);
		assert.deepEqual(pieces, ["The ratio is 3.5 to 1. Next one."]);
	});
});

describe("the byte range of a player", () => {
	it("reads one range, open at either end", () => {
		assert.deepEqual(byteRange("bytes=0-99", 1000), { start: 0, end: 99 });
		assert.deepEqual(byteRange("bytes=500-", 1000), { start: 500, end: 999 });
		assert.deepEqual(byteRange("bytes=-100", 1000), { start: 900, end: 999 });
		assert.deepEqual(byteRange("bytes=900-5000", 1000), { start: 900, end: 999 }, "the end is cut to the file");
		assert.deepEqual(byteRange("bytes=-5000", 1000), { start: 0, end: 999 });
	});
	it("sends the whole file when no range is asked or it is not one this reads", () => {
		for (const h of [null, "", "items=0-5", "bytes=-", "bytes=a-b", "bytes=0-5,10-20"]) assert.equal(byteRange(h, 1000), null, String(h));
	});
	it("refuses a range outside the file", () => {
		assert.equal(byteRange("bytes=1000-", 1000), "unsatisfiable");
		assert.equal(byteRange("bytes=50-10", 1000), "unsatisfiable");
		assert.equal(byteRange("bytes=0-5", 0), "unsatisfiable");
	});
});
