/**
 * Create's pure rules (src/core/create.ts): reading the model's answer,
 * checking a draft question, building a card's fields, cleaning settings.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_MCQ_SETTINGS } from "../src/core/contracts/create.ts";
import {
	cardHtml,
	cleanMcqSettings,
	clampPageRange,
	countPages,
	mcqCardFields,
	pageNumbers,
	pageOfQuestionId,
	parseModelJson,
	questionId,
	validateMcqQuestion,
} from "../src/core/create.ts";

const good = {
	question: "Which of the following statements describe the scapula?",
	options: { A: "It is a flat bone", B: "It has a coracoid process", C: "It is a long bone", D: "It articulates with the femur" },
	correct: ["B", "A"],
	explanation: "A correct.\nB correct.\nC incorrect.\nD incorrect.",
};

describe("parseModelJson", () => {
	it("reads a plain object", () => {
		assert.deepEqual(parseModelJson('{"questions": []}'), { questions: [] });
	});

	it("unwraps a code fence", () => {
		assert.deepEqual(parseModelJson('Here you go:\n```json\n{"a": 1}\n```\nDone.'), { a: 1 });
	});

	it("cuts the object out of surrounding prose", () => {
		assert.deepEqual(parseModelJson('Sure! {"a": {"b": 2}} Hope that helps.'), { a: { b: 2 } });
	});

	it("refuses text without an object, and arrays", () => {
		assert.throws(() => parseModelJson("no json here"));
		assert.throws(() => parseModelJson("[1, 2]"));
		assert.throws(() => parseModelJson(""));
	});
});

describe("validateMcqQuestion", () => {
	it("accepts a complete question and sorts the correct letters", () => {
		const q = validateMcqQuestion(good);
		assert.deepEqual(q?.correct, ["A", "B"]);
		assert.equal(q?.options.C, "It is a long bone");
	});

	it("normalises letters (case, blanks, repeats) and trims the texts", () => {
		const q = validateMcqQuestion({ ...good, question: "  Q?  ", correct: ["b", " B ", "c"] });
		assert.equal(q?.question, "Q?");
		assert.deepEqual(q?.correct, ["B", "C"]);
	});

	it("drops letters outside A-D but keeps the question when some remain", () => {
		assert.deepEqual(validateMcqQuestion({ ...good, correct: ["A", "E", 7] })?.correct, ["A"]);
	});

	it("rejects a question that misses the minimum", () => {
		assert.equal(validateMcqQuestion(null), null);
		assert.equal(validateMcqQuestion([]), null);
		assert.equal(validateMcqQuestion({ ...good, question: " " }), null);
		assert.equal(validateMcqQuestion({ ...good, explanation: "" }), null);
		assert.equal(validateMcqQuestion({ ...good, options: { A: "a", B: "b", C: "c" } }), null);
		assert.equal(validateMcqQuestion({ ...good, options: { ...good.options, D: "  " } }), null);
		assert.equal(validateMcqQuestion({ ...good, correct: "A" }), null);
	});

	it("rejects none or all four correct (a trivial question)", () => {
		assert.equal(validateMcqQuestion({ ...good, correct: [] }), null);
		assert.equal(validateMcqQuestion({ ...good, correct: ["A", "B", "C", "D"] }), null);
		assert.notEqual(validateMcqQuestion({ ...good, correct: ["A", "B", "C"] }), null);
	});
});

describe("card text", () => {
	it("escapes HTML, keeps **bold** and turns line breaks into <br>", () => {
		assert.equal(cardHtml("a < b & **c**\nd"), "a &lt; b &amp; <b>c</b><br>d");
		assert.equal(cardHtml("<script>x</script>"), "&lt;script&gt;x&lt;/script&gt;");
	});

	it("builds the field set the study screen renders", () => {
		const q = validateMcqQuestion(good)!;
		const fields = mcqCardFields(q, "Anatomy · p. 3");
		assert.deepEqual(Object.keys(fields).sort(), ["Correct", "Explanation", "OptionA", "OptionB", "OptionC", "OptionD", "Question", "Source"]);
		assert.equal(fields.Correct, "A, B");
		assert.equal(fields.Explanation, "A correct.<br>B correct.<br>C incorrect.<br>D incorrect.");
		assert.equal(fields.Source, "Anatomy · p. 3");
	});
});

describe("question ids and page ranges", () => {
	it("numbers questions by page and index, and reads the page back", () => {
		assert.equal(questionId(3, 2), "p003-q02");
		assert.equal(questionId(120, 11), "p120-q11");
		assert.equal(pageOfQuestionId("p003-q02"), 3);
		assert.equal(pageOfQuestionId("p120-q11"), 120);
		assert.equal(pageOfQuestionId("q02"), null);
		assert.equal(pageOfQuestionId("p3-q2"), null);
		assert.equal(pageOfQuestionId("../p003-q02"), null);
	});

	it("clamps the range to the document; 0 as the end means the last page", () => {
		assert.deepEqual(clampPageRange(1, 0, 10), { from: 1, to: 10 });
		assert.deepEqual(clampPageRange(3, 5, 10), { from: 3, to: 5 });
		assert.deepEqual(clampPageRange(0, 99, 10), { from: 1, to: 10 });
		assert.deepEqual(clampPageRange(20, 0, 10), { from: 10, to: 10 });
	});
});

describe("cleanMcqSettings", () => {
	it("falls back to the defaults for anything missing or wrong", () => {
		assert.deepEqual(cleanMcqSettings(undefined), DEFAULT_MCQ_SETTINGS);
		assert.deepEqual(cleanMcqSettings("nonsense"), DEFAULT_MCQ_SETTINGS);
		assert.deepEqual(cleanMcqSettings({ model: "no good!", language: "fr", questionsPerPage: "many" }), DEFAULT_MCQ_SETTINGS);
	});

	it("takes valid values and clamps the numbers", () => {
		const s = cleanMcqSettings({ model: "haiku", language: "de", questionsPerPage: 50, pageFrom: "2", pageTo: 9, concurrency: 9 });
		assert.deepEqual(s, { model: "haiku", language: "de", questionsPerPage: 10, pageFrom: 2, pageTo: 9, concurrency: 4 });
		assert.equal(cleanMcqSettings({ questionsPerPage: 0 }).questionsPerPage, 1);
		assert.equal(cleanMcqSettings({ model: "claude-sonnet-5-5" }).model, "claude-sonnet-5-5");
	});
});

describe("page counters", () => {
	it("counts statuses and lists pages in numeric order", () => {
		const pages = {
			"10": { status: "done" as const, count: 2, adopted: 0 },
			"2": { status: "pending" as const, count: 0, adopted: 0 },
			"3": { status: "error" as const, count: 0, adopted: 0 },
		};
		assert.deepEqual(countPages(pages), { pending: 1, running: 0, done: 1, error: 1 });
		assert.deepEqual(pageNumbers({ pages }), [2, 3, 10]);
	});
});
