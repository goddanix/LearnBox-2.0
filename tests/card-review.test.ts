/** The critic and glossary helpers (src/core/card-review.ts): what a verdict does to a card, which pages feed the glossary. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyVerdicts, cardBrief, criticPageText, flaggedCards, glossaryMaterial, MAX_FLAGGED_PER_CALL, pageText, parseGlossary, samplePages } from "../src/core/card-review.ts";
import type { CardDraft, FrontBackCard, LegendClozeCard, OcclusionCard } from "../src/core/contracts/create-cards.ts";
import type { Box, PageLine } from "../src/core/contracts/page-layout.ts";

const base = { page: 3, tier: 2 as const, whyType: "", extra: "", evidence: "", tags: [], deleted: false, include: true, manual: false, sourceIds: [], sourceBbox: null, image: null };

const basic = (id: string, front: string, back: string, warnings: string[] = []): FrontBackCard => ({ ...base, id, type: "basic", front, back, warnings });

const line = (id: string, text: string, extra: Partial<PageLine> = {}): PageLine => ({
	id,
	text,
	bbox: [0, 0, 1, 0.1] as Box,
	tight: null,
	size: 10,
	src: "pdf",
	bold: false,
	italic: false,
	underline: false,
	inFigure: false,
	...extra,
});

describe("critic", () => {
	it("looks at flagged, live cards only, a call's worth at most", () => {
		const cards: CardDraft[] = [
			basic("p003-c01", "q", "a"),
			basic("p003-c02", "q", "a", ["w"]),
			{ ...basic("p003-c03", "q", "a", ["w"]), deleted: true },
			...Array.from({ length: 15 }, (_, i) => basic(`p003-c${10 + i}`, "q", "a", ["w"])),
		];
		const flagged = flaggedCards(cards);
		assert.equal(flagged.length, MAX_FLAGGED_PER_CALL);
		assert.equal(flagged[0]!.id, "p003-c02");
		assert.ok(flagged.every((c) => !c.deleted && c.warnings.length > 0));
	});

	it("shows the critic the text of a card, the header and label of an occlusion", () => {
		const occ = { ...base, id: "p003-c05", type: "image_occlusion", header: "Name it", label: "Aorta", warnings: ["x"], boxes: [] } as unknown as OcclusionCard;
		const cloze = { ...base, id: "p003-c06", type: "cloze", text: "{{c1::Aorta}}", warnings: ["y"] } as unknown as LegendClozeCard;
		assert.deepEqual(cardBrief(basic("p003-c01", "Q?", "A", ["w"])), { id: "p003-c01", type: "basic", warnings: ["w"], front: "Q?", back: "A" });
		assert.deepEqual(cardBrief(occ), { id: "p003-c05", type: "image_occlusion", warnings: ["x"], header: "Name it", label: "Aorta" });
		assert.deepEqual(cardBrief(cloze), { id: "p003-c06", type: "cloze", warnings: ["y"], text: "{{c1::Aorta}}" });
	});

	it("gives the page text as '[id] text' lines, empty ones left out", () => {
		const text = criticPageText({ lines: [line("L1", "First"), line("L2", "   "), line("O1", "Second", { src: "ocr" })] });
		assert.equal(text, "[L1] First\n[O1] Second");
		assert.equal(criticPageText({ lines: [line("L1", "x".repeat(7000))] }).length, 6000);
	});

	it("deletes a card with the reason, softly", () => {
		const c = basic("p003-c02", "q", "a", ["No evidence quote given"]);
		assert.equal(applyVerdicts([c], { cards: [{ id: "p003-c02", verdict: "delete", reason: "Not on the page" }] }), 1);
		assert.equal(c.deleted, true);
		assert.equal(c.note, "Critic: Not on the page");
		const d = basic("p003-c03", "q", "a", ["w"]);
		applyVerdicts([d], { cards: [{ id: "p003-c03", verdict: "DELETE" }] });
		assert.equal(d.note, "Critic: unclear / not backed by the page");
	});

	it("rewrites a card, re-checks its quality and keeps the evidence warning", () => {
		const long = "x".repeat(300);
		const c = basic("p003-c02", long, "a", ["Question is very long", "Evidence quote not found in the page text — please check the content"]);
		applyVerdicts([c], { cards: [{ id: "p003-c02", verdict: "fix", front: "Myocardial infarction – how does troponin T change?", back: "<b>It rises.</b>", reason: "context added" }] });
		assert.equal(c.front, "Myocardial infarction – how does troponin T change?");
		assert.equal(c.back, "It rises.");
		assert.deepEqual(c.warnings, ["Evidence quote not found in the page text — please check the content"]);
		assert.equal(c.note, "Critic: wording adjusted (context added)");
	});

	it("ignores a fix without both sides, and a cloze fix with broken syntax", () => {
		const c = basic("p003-c02", "q", "a", ["w"]);
		assert.equal(applyVerdicts([c], { cards: [{ id: "p003-c02", verdict: "fix", front: "only front" }] }), 0);
		assert.deepEqual([c.front, c.back, c.warnings], ["q", "a", ["w"]]);
		const g = { ...base, id: "p003-c06", type: "cloze", text: "{{c1::Aorta}}", warnings: ["y"] } as unknown as LegendClozeCard;
		assert.equal(applyVerdicts([g], { cards: [{ id: "p003-c06", verdict: "fix", text: "no gap" }] }), 0);
		assert.equal(g.text, "{{c1::Aorta}}");
		assert.equal(applyVerdicts([g], { cards: [{ id: "p003-c06", verdict: "fix", text: "{{c1::Aorta}}\n{{c2::Vena}}" }] }), 1);
		assert.equal(g.text, "{{c1::Aorta}}\n{{c2::Vena}}");
	});

	it("clears the warnings of a card the critic confirms, and ignores unknown ids and junk", () => {
		const c = basic("p003-c02", "q", "a", ["w1", "w2"]);
		assert.equal(applyVerdicts([c], { cards: [{ id: "p003-c02", verdict: "ok" }, { id: "nope", verdict: "delete" }, "junk", { verdict: "delete" }] }), 1);
		assert.deepEqual(c.warnings, []);
		assert.equal(c.deleted, false);
		assert.equal(applyVerdicts([c], null), 0);
		assert.equal(applyVerdicts([c], { cards: "x" }), 0);
	});
});

describe("glossary", () => {
	it("samples pages spread over the document", () => {
		assert.deepEqual(samplePages([3, 1, 2]), [1, 2, 3]);
		const pages = Array.from({ length: 60 }, (_, i) => i + 1);
		assert.deepEqual(samplePages(pages), [1, 11, 21, 31, 41, 51]);
		assert.deepEqual(samplePages([5, 9, 11, 14, 20, 21, 30], 3), [5, 11, 20]);
	});

	it("marks emphasised lines with a star and leaves legend entries out", () => {
		const text = pageText({ lines: [line("L1", "Heading", { bold: true }), line("L2", "  plain  "), line("G1", "Aorta", { src: "legend" }), line("L3", ""), line("L4", "slanted", { italic: true })] });
		assert.equal(text, "★ Heading\nplain\n★ slanted");
	});

	it("builds the material per page and cuts it to a call's worth", () => {
		const material = glossaryMaterial([
			{ page: 1, layout: { lines: [line("L1", "Heart")] } },
			{ page: 4, layout: { lines: [line("L1", "   ")] } },
			{ page: 9, layout: { lines: [line("L1", "Aorta", { bold: true })] } },
		]);
		assert.equal(material, "=== Seite 1 ===\nHeart\n\n=== Seite 9 ===\n★ Aorta");
		assert.equal(glossaryMaterial([{ page: 1, layout: { lines: [line("L1", "x".repeat(9000))] } }]).length, 6000);
		assert.equal(glossaryMaterial([]), "");
	});

	it("reads the model's terms: canonical with variants, shortened, at most 30", () => {
		const raw = {
			terms: [
				{ canonical: " Troponin T ", variants: ["Troponin-T", " TnT ", ""] },
				{ canonical: "no variants", variants: [] },
				{ canonical: "", variants: ["x"] },
				"junk",
				{ canonical: "y".repeat(80), variants: ["a", "b", "c", "d", "e", "f"] },
				...Array.from({ length: 40 }, (_, i) => ({ canonical: `T${i}`, variants: ["v"] })),
			],
		};
		const terms = parseGlossary(raw);
		assert.deepEqual(terms[0], { canonical: "Troponin T", variants: ["Troponin-T", "TnT"] });
		assert.equal(terms[1]!.canonical.length, 60);
		assert.deepEqual(terms[1]!.variants, ["a", "b", "c", "d", "e"]);
		assert.equal(terms.length, 30);
		assert.deepEqual(parseGlossary({ terms: "x" }), []);
		assert.deepEqual(parseGlossary(null), []);
	});
});
