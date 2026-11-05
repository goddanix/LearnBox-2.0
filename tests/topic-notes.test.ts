/**
 * The notes of a course are MedAnki's: tests/fixtures/medanki-vault.json holds what MedAnki's own Python code
 * produces (regenerate with tests/fixtures/gen-medanki-vault.py) — the verbatim German prompts and the pure helpers
 * around a topic note. Below that: the parts Learnbox added (which cards a note rests on, the pages of a topic).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HEADING_SYSTEM, headingPrompt, LINK_SYSTEM, linkPrompt, TOPIC_SYSTEM, topicPrompt, TRIM_SYSTEM, trimPrompt } from "../src/agent/create/notes-prompts.ts";
import type { NoteSource } from "../src/core/contracts/create-notes.ts";
import {
	cardsByTopic,
	CARDS_MAX,
	captionFor,
	countWords,
	FIG_CANDIDATES,
	figureCandidates,
	HEADING_BATCH,
	linkRefs,
	MAX_PAGES,
	PAGE_WORDS,
	pageText,
	parseHeadingAssignments,
	shortName,
	sourcePages,
	stub,
	tidy,
	TOPIC_FIGS,
	toObsidianTopic,
	TRIM_FACTOR,
	trimWords,
	WORDS_MAX,
	WORDS_MIN,
	WORKERS,
	wordBudget,
} from "../src/core/topic-notes.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/medanki-vault.json", import.meta.url), "utf8"));
const h = fx.topicHelpers;
const refs: Record<string, NoteSource> = Object.fromEntries(
	Object.entries(fx.topicHelpers.toObsidianTopic[0].refs as Record<string, { ref: string; job_id: string; name: string; pdf_file: string }>).map(([k, v]) => [k, { ref: v.ref, jobId: v.job_id, name: v.name, pdfFile: v.pdf_file }]),
);

describe("the limits", () => {
	it("are MedAnki's", () => {
		const t = fx.constants.topic;
		assert.deepEqual([MAX_PAGES, PAGE_WORDS, CARDS_MAX, TOPIC_FIGS, FIG_CANDIDATES, WORDS_MIN, WORDS_MAX, WORKERS], [t.MAX_PAGES, t.PAGE_WORDS, t.CARDS_MAX, t.TOPIC_FIGS, t.FIG_CANDIDATES, t.WORDS_MIN, t.WORDS_MAX, t.WORKERS]);
		assert.equal(TRIM_FACTOR, fx.constants.notes.TRIM_FACTOR);
		assert.equal(HEADING_BATCH, fx.prompts.headingBatch);
	});
});

describe("the text of a page", () => {
	it("is read the way MedAnki reads it", () => {
		assert.equal(pageText(h.layout), h.pageText);
		assert.ok(h.pageText.includes("★ Ribs"), "emphasis is marked");
		assert.ok(!h.pageText.includes("Legend text"), "a legend entry is left out");
	});
	it("counts words the way MedAnki does", () => {
		for (const c of h.countWords) assert.equal(countWords(c.text), c.out);
	});
	it("finds the caption of a figure", () => {
		h.layout.figures.forEach((f: { bbox: number[] }, i: number) => assert.equal(captionFor(f.bbox, h.layout.lines), h.captionFor[i].out));
	});
	it("picks the figures that suit a note", () => {
		for (const c of h.figureCandidates) assert.deepEqual(figureCandidates(h.figureCandidatesInput, c.limit), c.out);
	});
	it("cuts a text to a word budget by lines", () => {
		for (const c of h.trimWords) assert.equal(trimWords(c.text, c.limit), c.out);
	});
});

describe("from the model's Markdown to Obsidian", () => {
	it("names a source briefly", () => {
		for (const c of h.short) assert.equal(shortName(c.name), c.out);
	});
	it("turns source marks into page links", () => {
		for (const c of h.linkRefs) assert.equal(linkRefs(c.md, refs), c.out);
	});
	it("keeps a picture in a paragraph of its own", () => {
		for (const c of h.tidy) assert.equal(tidy(c.md), c.out);
	});
	it("turns the Markdown of a topic into Obsidian's, with its pictures and links", () => {
		for (const c of h.toObsidianTopic) {
			const cands = c.cands.map((x: { id: string; page: number; ref: string; src: string; caption: string }) => ({ id: x.id, page: x.page, ref: x.ref, src: x.src, caption: x.caption }));
			assert.deepEqual(toObsidianTopic(c.markdown, { topic: c.topic, refs, cands, maxFigs: c.maxFigs }), c.out);
		}
	});
	it("starts a note set with a row per topic", () => {
		for (const c of h.stub) {
			const row = stub(...(c.args as [number, string, number, number?]));
			assert.deepEqual(
				[row.id, row.ix, row.topic, row.kind, row.cards, row.pages, row.refs, row.markdown, row.words, row.figures, row.include, row.error],
				[c.out.id, c.out.ix, c.out.topic, c.out.kind, c.out.cards, c.out.pages, c.out.refs, c.out.markdown, c.out.words, c.out.figures, c.out.include, c.out.error],
			);
			assert.equal(row.skipReason === "", c.out.skip_reason === "");
		}
	});
});

describe("the prompts", () => {
	it("are MedAnki's, word for word", () => {
		assert.equal(TOPIC_SYSTEM, fx.prompts.topicSystem);
		assert.equal(TRIM_SYSTEM, fx.prompts.trimSystem);
		assert.equal(LINK_SYSTEM, fx.prompts.linkSystem);
		assert.equal(HEADING_SYSTEM, fx.prompts.headingSystem);
		const p = fx.prompts.topicPrompt;
		assert.equal(topicPrompt(p.course, p.topic, p.cards, p.material, p.cands, p.words, p.figs), p.out);
		assert.equal(topicPrompt(p.course, "Ribs", [], "m", [], 350, 0), p.noCands);
		assert.equal(trimPrompt(fx.prompts.trimPrompt.words, fx.prompts.trimPrompt.markdown), fx.prompts.trimPrompt.out);
		assert.equal(linkPrompt(fx.prompts.linkPrompt.sources), fx.prompts.linkPrompt.out);
		const hp = fx.prompts.headingPrompt;
		assert.equal(headingPrompt(hp.topics, hp.batch), hp.out);
	});
	it("tell the model to answer in English", () => {
		assert.ok(TOPIC_SYSTEM.includes("Write in English"));
	});
});

describe("what a note rests on (Learnbox)", () => {
	it("gives half the source words as the budget, within the limits, halves going to the even number like Python", () => {
		assert.equal(wordBudget(100), WORDS_MIN);
		assert.equal(wordBudget(100_000), WORDS_MAX);
		assert.equal(wordBudget(801), 400); // 400.5 → 400
		assert.equal(wordBudget(803), 402); // 401.5 → 402
		assert.equal(wordBudget(900), 450);
	});

	it("takes the selected cards that are not thrown away, by topic label", () => {
		const card = (tags: string[], over: { deleted?: boolean; include?: boolean } = {}) => ({ card: { tags, deleted: over.deleted ?? false, include: over.include ?? true } });
		const items = [card(["Heart"]), card(["Heart", "Valves"]), card(["Heart"], { deleted: true }), card(["Valves"], { include: false }), card(["Other topic"]), card([])];
		const by = cardsByTopic(items, new Set(["Heart", "Valves"]));
		assert.equal(by.get("Heart")?.length, 2);
		assert.equal(by.get("Valves")?.length, 1);
		assert.equal(by.has("Other topic"), false);
	});

	it("reads the pages of a topic: most cards first, at most MAX_PAGES, then in PDF and page order", () => {
		const order = new Map([["a", 0], ["b", 1]]);
		const cards = [{ jobId: "b", page: 2 }, { jobId: "a", page: 9 }, { jobId: "a", page: 9 }, { jobId: "a", page: 3 }, { jobId: "b", page: 2 }, { jobId: "b", page: 1 }];
		assert.deepEqual(sourcePages(cards, order), [{ jobId: "a", page: 3 }, { jobId: "a", page: 9 }, { jobId: "b", page: 1 }, { jobId: "b", page: 2 }]);
		const many = Array.from({ length: 40 }, (_, i) => ({ jobId: "a", page: i + 1 }));
		assert.equal(sourcePages(many, order).length, MAX_PAGES);
	});

	it("reads the model's heading match, ignoring what does not fit", () => {
		const keys = new Set(["j1:3", "j1:4", "j2:7"]);
		const raw = { assignments: [{ id: "j1:3", topic: 1 }, { id: "j1:4", topic: "2" }, { id: "j2:7", topic: 0 }, { id: "j9:1", topic: 1 }, { id: "j1:3", topic: 9 }, "x", { id: "j2:7", topic: null }, { id: "j2:7", topic: 1 }] };
		const out = parseHeadingAssignments(raw, keys, ["Heart", "Valves"]);
		assert.deepEqual(out.get("Heart"), [{ jobId: "j1", page: 3 }, { jobId: "j2", page: 7 }]);
		assert.deepEqual(out.get("Valves"), [{ jobId: "j1", page: 4 }]);
		assert.equal(parseHeadingAssignments("no", keys, ["Heart"]).size, 0);
		assert.equal(parseHeadingAssignments({ assignments: "x" }, keys, ["Heart"]).size, 0);
	});
});
