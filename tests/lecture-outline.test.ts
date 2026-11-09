/**
 * Lecture outliner tests — deterministic, zero network, zero real LLM:
 *
 *   1. pure helpers: page splitting, windowing, the window laws, continuation
 *      merging
 *   2. the agent over a real text PDF with a scripted (faux) engine: one
 *      window, a window boundary with a continued topic, a rejected
 *      submit that the model retries, thin pages reported, a PDF with no
 *      text refused
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import {
	buildLectureOutline,
	detectLanguage,
	mergeWindow,
	splitPages,
	windowPages,
	windowProblem,
} from "../src/agent/subagents/lecture-outline.ts";
import type { LectureTopic } from "../src/core/contracts.ts";
import { textPdf, words } from "./fixtures/text-pdf.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lb-outline-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writePdf(name: string, bytes: Uint8Array): string {
	const file = path.join(tmp, name);
	fs.writeFileSync(file, bytes);
	return file;
}

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A model response that submits the given topics. */
const submit = (topics: unknown[], onCall?: (context: unknown) => void): FauxResponseStep => (context) => {
	onCall?.(context);
	return fauxAssistantMessage([fauxToolCall("submit_topics", { topics } as unknown as ToolCall["arguments"], { id: "submit-call" })], {
		stopReason: "toolUse",
	});
};

describe("outline helpers", () => {
	it("splits '--- Page N ---' extraction into a page map", () => {
		const pages = splitPages("--- Page 1 ---\nfirst\n--- Page 2 ---\nsecond line\nmore\n--- Page 3 ---\n");
		assert.equal(pages.get(1), "first");
		assert.equal(pages.get(2), "second line\nmore");
		assert.equal(pages.get(3), "");
	});

	it("packs pages into windows by size and always keeps one page per window at least", () => {
		const small = new Map([[1, "a".repeat(100)], [2, "b".repeat(100)], [3, "c".repeat(100)]]);
		assert.deepEqual(windowPages(small, 3), [{ start: 1, end: 3 }]);
		const big = new Map(Array.from({ length: 7 }, (_, i) => [i + 1, "x".repeat(5000)] as [number, string]));
		assert.deepEqual(windowPages(big, 7), [{ start: 1, end: 4 }, { start: 5, end: 7 }]);
		const huge = new Map(Array.from({ length: 6 }, (_, i) => [i + 1, "x".repeat(50_000)] as [number, string]));
		assert.deepEqual(
			windowPages(huge, 6),
			[{ start: 1, end: 4 }, { start: 5, end: 6 }],
			"a page counts for at most 6000 characters, so one huge page cannot starve a window",
		);
	});

	it("enforces the window laws with a message the model can act on", () => {
		const window = { start: 3, end: 6 };
		const content = new Set([3, 4, 5, 6]);
		const topic = (title: string, pageStart: number, pageEnd: number) => ({ title, summary: "s", pageStart, pageEnd });
		assert.equal(windowProblem([topic("A", 3, 4), topic("B", 5, 6)], window, content), null);
		assert.match(windowProblem([topic("A", 2, 4), topic("B", 5, 6)], window, content) ?? "", /outside the pages shown/);
		assert.match(windowProblem([topic("A", 5, 4)], window, content) ?? "", /after pageEnd/);
		assert.match(windowProblem([topic("A", 3, 5), topic("B", 5, 6)], window, content) ?? "", /overlaps/);
		assert.match(windowProblem([topic("A", 3, 4)], window, content) ?? "", /not covered.*5, 6/);
		assert.equal(windowProblem([topic("A", 3, 4)], window, new Set([3, 4])), null, "thin pages need no topic");
	});

	it("merges a continuation into the previous topic instead of adding one", () => {
		const acc: LectureTopic[] = [{ id: "", title: "Diffusion", summary: "Fick", pageStart: 1, pageEnd: 4 }];
		mergeWindow(acc, [
			{ title: "ignored", summary: "ignored", pageStart: 5, pageEnd: 6, continuesPrevious: true },
			{ title: "Osmosis", summary: "water", pageStart: 7, pageEnd: 8 },
		]);
		assert.equal(acc.length, 2);
		assert.equal(acc[0]!.title, "Diffusion");
		assert.equal(acc[0]!.pageEnd, 6);
		assert.equal(acc[1]!.title, "Osmosis");
		const lone: LectureTopic[] = [];
		mergeWindow(lone, [{ title: "First", summary: "s", pageStart: 1, pageEnd: 2, continuesPrevious: true }]);
		assert.equal(lone.length, 1, "a continuation with nothing before it is a new topic");
	});
});

describe("buildLectureOutline", () => {
	it("outlines a short lecture in one window and assigns ids in page order", async () => {
		const pdf = writePdf("short.pdf", textPdf([words(30, "title"), words(30, "nernst"), words(30, "ghk")]));
		const outline = await buildLectureOutline(pdf, {
			engine: fauxEngine([
				submit([
					{ title: "Ion gradients", summary: "Concentration differences drive ion flow.", pageStart: 1, pageEnd: 2 },
					{ title: "Goldman equation", summary: "Membrane potential from several permeant ions.", pageStart: 3, pageEnd: 3 },
				]),
			]),
		});
		assert.deepEqual(outline.topics.map((t) => [t.id, t.title, t.pageStart, t.pageEnd]), [
			["t1", "Ion gradients", 1, 2],
			["t2", "Goldman equation", 3, 3],
		]);
		assert.equal(outline.thinPages, undefined);
		assert.ok(!Number.isNaN(Date.parse(outline.generatedAt)));
	});

	it("continues a topic across a window boundary and shows the model the topics so far", async () => {
		const pdf = writePdf("long.pdf", textPdf(Array.from({ length: 7 }, (_, i) => `p${i + 1} ${words(800, `w${i}x`)}`)));
		const seen: string[] = [];
		const outline = await buildLectureOutline(pdf, {
			engine: fauxEngine([
				submit([{ title: "Membrane transport", summary: "Passive and active.", pageStart: 1, pageEnd: 4 }], (c) => seen.push(JSON.stringify(c))),
				submit([
					{ title: "unused", summary: "unused", pageStart: 5, pageEnd: 5, continuesPrevious: true },
					{ title: "Action potentials", summary: "Spikes.", pageStart: 6, pageEnd: 7 },
				], (c) => seen.push(JSON.stringify(c))),
			]),
		});
		assert.deepEqual(outline.topics.map((t) => [t.title, t.pageStart, t.pageEnd]), [
			["Membrane transport", 1, 5],
			["Action potentials", 6, 7],
		]);
		assert.match(seen[1]!, /Membrane transport \(pp\. 1-4\)/, "the second window sees the first window's topic");
	});

	it("makes the model retry a submit that breaks the window laws", async () => {
		const pdf = writePdf("retry.pdf", textPdf([words(30, "a"), words(30, "b")]));
		let calls = 0;
		const outline = await buildLectureOutline(pdf, {
			engine: fauxEngine([
				submit([{ title: "Too far", summary: "s", pageStart: 1, pageEnd: 9 }], () => calls++),
				submit([{ title: "Both pages", summary: "s", pageStart: 1, pageEnd: 2 }], () => calls++),
			]),
		});
		assert.equal(calls, 2, "the rejected submit was answered with a second call");
		assert.equal(outline.topics[0]!.title, "Both pages");
	});

	it("reports pages without text as thin instead of guessing", async () => {
		const pdf = writePdf("thin.pdf", textPdf([words(30, "real"), "x", words(30, "more")]));
		const outline = await buildLectureOutline(pdf, {
			engine: fauxEngine([
				submit([
					{ title: "Before", summary: "s", pageStart: 1, pageEnd: 1 },
					{ title: "After", summary: "s", pageStart: 3, pageEnd: 3 },
				]),
			]),
		});
		assert.deepEqual(outline.thinPages, [2]);
	});

	it("refuses a PDF with no extractable text, without calling the model", async () => {
		const pdf = writePdf("blank.pdf", textPdf(["", ""]));
		let called = false;
		await assert.rejects(
			() => buildLectureOutline(pdf, { engine: fauxEngine([submit([], () => (called = true))]) }),
			/no extractable text/,
		);
		assert.equal(called, false);
	});

	it("reports progress per window", async () => {
		const pdf = writePdf("progress.pdf", textPdf(Array.from({ length: 7 }, (_, i) => `p${i + 1} ${words(800, `w${i}x`)}`)));
		const progress: Array<[number, number]> = [];
		await buildLectureOutline(pdf, {
			onProgress: (done, total) => progress.push([done, total]),
			engine: fauxEngine([
				submit([{ title: "A", summary: "s", pageStart: 1, pageEnd: 4 }]),
				submit([{ title: "B", summary: "s", pageStart: 5, pageEnd: 7 }]),
			]),
		});
		assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]]);
	});
});

const EN = "The Nernst equation gives the equilibrium potential of a single ion species, which is reached when the diffusive flux and the electrical drift cancel each other across the membrane. It depends on the ratio of the concentrations outside and inside the cell, and on the temperature.";
const DE = "Die Nernst-Gleichung liefert das Gleichgewichtspotential einer einzelnen Ionensorte, das erreicht wird, wenn sich der diffusive Fluss und die elektrische Drift an der Membran gegenseitig aufheben. Es hängt vom Verhältnis der Konzentrationen außerhalb und innerhalb der Zelle sowie von der Temperatur ab.";
const FR = "L'équation de Nernst donne le potentiel d'équilibre d'une seule espèce d'ions, qui est atteint lorsque le flux de diffusion et la dérive électrique s'annulent de part et d'autre de la membrane. Il dépend du rapport des concentrations à l'extérieur et à l'intérieur de la cellule.";

describe("language of the slides", () => {
	it("detects English, German and French prose", () => {
		assert.equal(detectLanguage(EN), "English");
		assert.equal(detectLanguage(DE), "German");
		assert.equal(detectLanguage(FR), "French");
	});

	it("refuses to guess: too little text, formulas and unknown vocabulary give null", () => {
		assert.equal(detectLanguage("Nernst equation"), null);
		assert.equal(detectLanguage("E = (R T / z F) ln(c_out / c_in) = 61.5 mV log10(5/140) = -89 mV ".repeat(6)), null);
		assert.equal(detectLanguage(words(60, "zz")), null);
		assert.equal(detectLanguage(""), null);
	});

	it("a submit in another language than the pages is rejected with the language named", () => {
		const topic = (title: string, summary: string) => [{ title, summary, pageStart: 1, pageEnd: 1 }];
		const window = { start: 1, end: 1 };
		const content = new Set([1]);
		const german = topic("Nernst-Gleichung", "Die Gleichung liefert das Gleichgewichtspotential einer einzelnen Ionensorte und hängt vom Verhältnis der Konzentrationen ab, wenn der Fluss null ist.");
		const english = topic("Nernst equation", "The equation gives the equilibrium potential of a single ion species and depends on the ratio of the concentrations when the flux is zero.");
		assert.match(windowProblem(german, window, content, "English") ?? "", /must be written in English.*this submit is in German/);
		assert.equal(windowProblem(english, window, content, "English"), null);
		assert.equal(windowProblem(german, window, content, "German"), null);
		assert.equal(windowProblem(german, window, content, null), null, "no detected language, no enforcement");
		assert.equal(windowProblem(topic("Nernst", "Nernst equation"), window, content, "English"), null, "too short to judge is accepted");
	});

	it("tells the model the detected language and makes it rewrite a submit in the wrong one", async () => {
		const pdf = writePdf("english.pdf", textPdf([EN, EN.replace("Nernst", "Goldman")]));
		const prompts: string[] = [];
		const record = (context: unknown) => prompts.push(JSON.stringify(context));
		const outline = await buildLectureOutline(pdf, {
			engine: fauxEngine([
				submit([{ title: "Nernst-Gleichung", summary: "Die Gleichung liefert das Gleichgewichtspotential einer einzelnen Ionensorte und hängt vom Verhältnis der Konzentrationen ab, wenn der Fluss null ist.", pageStart: 1, pageEnd: 2 }], record),
				submit([{ title: "Nernst equation", summary: "The equation gives the equilibrium potential of a single ion species and depends on the ratio of the concentrations when the flux is zero.", pageStart: 1, pageEnd: 2 }], record),
			]),
		});
		assert.equal(outline.topics[0]!.title, "Nernst equation", "the German submit was rejected and rewritten");
		assert.match(prompts[0]!, /Language of the lecture: English\. Write every title and summary in English\./);
		assert.match(prompts[1]!, /must be written in English/, "the model saw why it was rejected");
	});

	it("enforces German for a German lecture, and leaves an unclear language alone", async () => {
		const german = writePdf("german.pdf", textPdf([DE, DE.replace("Nernst", "Goldman")]));
		const prompts: string[] = [];
		await buildLectureOutline(german, {
			engine: fauxEngine([submit([{ title: "Nernst-Gleichung", summary: "Die Gleichung liefert das Gleichgewichtspotential einer Ionensorte und hängt vom Verhältnis der Konzentrationen ab.", pageStart: 1, pageEnd: 2 }], (c) => prompts.push(JSON.stringify(c)))]),
		});
		assert.match(prompts[0]!, /Language of the lecture: German\./);

		const unclear = writePdf("unclear.pdf", textPdf([words(40, "q"), words(40, "r")]));
		const seen: string[] = [];
		const outline = await buildLectureOutline(unclear, {
			engine: fauxEngine([submit([{ title: "Anything", summary: "A summary in whatever language it likes, which is fine here because the slides have no detectable language at all.", pageStart: 1, pageEnd: 2 }], (c) => seen.push(JSON.stringify(c)))]),
		});
		assert.equal(outline.topics.length, 1);
		assert.match(seen[0]!, /in the language of the pages below/);
		assert.doesNotMatch(seen[0]!, /Language of the lecture:/);
	});
});
