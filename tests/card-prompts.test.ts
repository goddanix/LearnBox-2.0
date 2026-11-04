/**
 * The card prompts are MedAnki's, word for word: tests/fixtures/medanki-card-prompts.json holds what MedAnki's own
 * Python code produces (regenerate with tests/fixtures/gen-medanki-card-prompts.py). Every text is compared here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	cardPagePrompt,
	cardSystemPrompt,
	cleanTopics,
	CRITIC_SYSTEM,
	criticPrompt,
	fixed3,
	focusHint,
	glossaryHint,
	glossaryPrompt,
	glossarySystemPrompt,
	kindHint,
	vocabSystemPrompt,
} from "../src/agent/create/card-prompts.ts";
import { repairSuffix } from "../src/agent/create/mcq-prompts.ts";
import { VOCAB_MAX_PER_PAGE } from "../src/core/contracts/create-cards.ts";
import type { PageLayout } from "../src/core/contracts/page-layout.ts";

const golden = JSON.parse(readFileSync(new URL("./fixtures/medanki-card-prompts.json", import.meta.url), "utf-8"));

describe("card prompts match MedAnki's", () => {
	for (const s of golden.systems) {
		it(`system prompt (${s.density}, ${s.language}, latin ${s.latin}, atlas ${s.atlas})`, () => {
			assert.equal(cardSystemPrompt({ density: s.density, language: s.language, latin: s.latin, atlas: s.atlas }), s.text);
		});
	}

	for (const v of golden.vocab) {
		it(`vocabulary sheet prompt (${v.lang})`, () => {
			assert.equal(vocabSystemPrompt(v.lang, VOCAB_MAX_PER_PAGE), v.text);
		});
	}

	it("glossary prompts", () => {
		assert.equal(glossarySystemPrompt(false), golden.glossarySystem.plain);
		assert.equal(glossarySystemPrompt(true), golden.glossarySystem.latin);
		assert.equal(glossaryPrompt("Anatomie Vorlesung 3.pdf", "=== Seite 1 ===\nHerz\n\n=== Seite 4 ===\n★ Aorta"), golden.glossaryPrompt);
		assert.equal(glossaryHint(golden.glossaryHint.terms), golden.glossaryHint.text);
		assert.equal(glossaryHint([]), golden.glossaryHint.empty);
	});

	it("focus and kind hints", () => {
		const { topics } = golden.focus;
		assert.equal(focusHint(topics, false), golden.focus.soft);
		assert.equal(focusHint(topics, true), golden.focus.strict);
		assert.equal(focusHint([], true), golden.focus.none);
		assert.equal(kindHint("practical"), golden.kindHint);
		assert.equal(kindHint("lecture"), "");
		assert.deepEqual(cleanTopics(golden.focus.clean.input), golden.focus.clean.output);
		assert.deepEqual(cleanTopics(["  a  b ", "A B", 3]), ["a b", "3"]);
		assert.deepEqual(cleanTopics(undefined), []);
	});

	it("critic prompts", () => {
		assert.equal(CRITIC_SYSTEM, golden.criticSystem);
		assert.equal(criticPrompt(golden.criticPrompt.pageText, golden.criticPrompt.cards), golden.criticPrompt.text);
	});

	it("repair suffix", () => {
		assert.equal(repairSuffix("JSON-Fehler: x"), golden.repairSuffix);
	});

	for (const page of golden.pages) {
		it(`page prompt (${page.name} layout)`, () => {
			const layout: PageLayout = { widthPt: 600, heightPt: 800, chars: 0, title: "", ...page.layout };
			assert.equal(cardPagePrompt({ docName: "Kardio.pdf", page: 3, nPages: 12, imageRel: "pages/p003.png", layout, prevTitle: "Vorher", nextTitle: "Nachher" }), page.text);
		});
	}
});

describe("fixed3", () => {
	it("rounds like Python's format: ties of exact binary values go to even", () => {
		assert.equal(fixed3(0.0625), "0.062");
		assert.equal(fixed3(0.1875), "0.188");
		assert.equal(fixed3(0.0015), "0.002"); // 0.0015 is a hair above the tie in binary
		assert.equal(fixed3(0.0005), "0.001");
		assert.equal(fixed3(0.5), "0.500");
		assert.equal(fixed3(1), "1.000");
		assert.equal(fixed3(0.3125), "0.312");
	});
});
