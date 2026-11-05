/**
 * MedAnki's PDF jobs in Learnbox's shapes (src/core/legacy-cards.ts): what MedAnki stored per card, page and job, read the way
 * MedAnki wrote it (snake_case, German density names, `priority`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CardDraft, OcclusionCard } from "../src/core/contracts/create-cards.ts";
import {
	legacyCard,
	legacyCardSettings,
	legacyCardTag,
	legacyGlossary,
	legacyHeadings,
	legacyJobState,
	legacyLayout,
	legacyMediaOf,
	legacyPageEntry,
	legacyPageResult,
} from "../src/core/legacy-cards.ts";

const base = (over: Record<string, unknown> = {}) => ({
	page: 3,
	priority: 1,
	why_type: "A bold statement",
	extra: "",
	evidence: "the sentence",
	tags: ["Anatomie"],
	warnings: ["Kein Beleg-Zitat angegeben"],
	deleted: false,
	include: true,
	manual: false,
	source_ids: ["L1", "L2"],
	source_bbox: [0.1, 0.2, 0.5, 0.3],
	image: null,
	id: "p003-c01",
	...over,
});

const occlusion = (over: Record<string, unknown> = {}) =>
	base({
		id: "p003-c02",
		type: "image_occlusion",
		priority: 2,
		header: "Name the hidden label",
		mode: "one",
		figure_bbox: [0, 0, 1, 1],
		figure_exact: false,
		mask_exact: true,
		label: "Tibia",
		hint: "",
		boxes: [[0.1, 0.1, 0.2, 0.15]],
		all_boxes: [
			[0.1, 0.1, 0.2, 0.15],
			[0.3, 0.1, 0.4, 0.15],
		],
		marker_bbox: null,
		needs_check: true,
		question_file: "io_p003-c02_q_aa.jpg",
		answer_file: "io_p003-c02_a_bb.jpg",
		fig_hash: "ab".repeat(32),
		mask_v: 2,
		auto_legend: true,
		note: "from the legend",
		...over,
	});

function card(raw: unknown, page = 3): CardDraft {
	const out = legacyCard(raw, page);
	assert.ok("card" in out, `expected a card, got ${JSON.stringify("dropped" in out ? out.dropped.reason : out)}`);
	return out.card;
}

describe("legacyCardTag", () => {
	it("is MedAnki's hidden tag of a pushed card", () => {
		assert.equal(legacyCardTag("20261011-110843-a3d2", "p001-c20"), "MedAnkiID_20261011-110843-a3d2_p001-c20");
	});
	it("treats odd characters the way MedAnki's _tag did", () => {
		assert.equal(legacyCardTag("my job", "p1 c2"), "MedAnkiID_my_job_p1_c2");
		assert.equal(legacyCardTag("Řez", "p1-c1"), "MedAnkiID_Řez_p1-c1");
		assert.equal(legacyCardTag("", ""), "MedAnkiID_Dokument");
	});
});

describe("legacyCardSettings", () => {
	it("turns MedAnki's German names and snake_case into a cards job's settings", () => {
		const s = legacyCardSettings({
			model: "sonnet",
			density: "knapp",
			language: "en",
			io_mode: "all",
			latin_terms: "on",
			whole_image_cards: true,
			focus_topics: ["Acoustics", "Pressure"],
			focus_strict: true,
			kind: "praktikum",
			vocab: true,
			vocab_lang: "Tschechisch",
			page_from: 2,
			page_to: 9,
			concurrency: 3,
		});
		assert.deepEqual(s, {
			model: "sonnet",
			density: "brief",
			language: "en",
			ioMode: "all",
			latinTerms: "on",
			wholeImageCards: true,
			focusTopics: ["Acoustics", "Pressure"],
			focusStrict: true,
			kind: "practical",
			vocab: true,
			vocabLang: "Tschechisch",
			pageFrom: 2,
			pageTo: 9,
			concurrency: 3,
		});
	});
	it("knows every density, and falls back to the defaults for what is missing (MedAnki wrote None)", () => {
		assert.equal(legacyCardSettings({ density: "konzept" }).density, "concept");
		assert.equal(legacyCardSettings({ density: "ausführlich" }).density, "thorough");
		assert.equal(legacyCardSettings({ density: "normal" }).density, "normal");
		const none = legacyCardSettings({ latin_terms: null, whole_image_cards: null, vocab: null });
		assert.equal(none.latinTerms, "auto");
		assert.equal(none.wholeImageCards, false);
		assert.equal(none.vocab, false);
		assert.equal(legacyCardSettings(null).kind, "lecture");
	});
});

describe("legacyCard", () => {
	it("a front/back card: priority becomes the tier, the flags and the sources stay", () => {
		const c = card(base({ type: "basic", front: "Q?", back: "A.", edited: true, prev_tags: ["Old"] }));
		assert.equal(c.type, "basic");
		assert.deepEqual({ id: c.id, page: c.page, tier: c.tier, deleted: c.deleted, include: c.include, manual: c.manual }, { id: "p003-c01", page: 3, tier: 1, deleted: false, include: true, manual: false });
		assert.equal(c.type === "basic" && c.front, "Q?");
		assert.deepEqual(c.sourceIds, ["L1", "L2"]);
		assert.deepEqual(c.sourceBbox, [0.1, 0.2, 0.5, 0.3]);
		assert.equal(c.whyType, "A bold statement");
		assert.deepEqual(c.warnings, ["Kein Beleg-Zitat angegeben"]);
		assert.equal(c.edited, true);
		assert.deepEqual(c.prevTags, ["Old"]);
		assert.equal(c.adopted, undefined);
	});

	it("keeps basic_reversed and process as they are, and a picture question becomes a front/back card with its picture", () => {
		assert.equal(card(base({ type: "basic_reversed", front: "a", back: "b" })).type, "basic_reversed");
		assert.equal(card(base({ type: "process", front: "a", back: "b" })).type, "process");
		const q = card(base({ type: "image_question", front: "What is shown?", back: "A wave", image: { bbox: [0, 0, 1, 1], where: "front", file: "img_p003-c01_x.jpg" } }));
		assert.equal(q.type, "basic");
		assert.deepEqual(q.image, { bbox: [0, 0, 1, 1], where: "front", file: "img_p003-c01_x.jpg" });
	});

	it("tier: 1–3 only, 2 when it is missing or odd; include is on unless MedAnki said otherwise", () => {
		assert.equal(card(base({ type: "basic", front: "a", back: "b", priority: 3 })).tier, 3);
		assert.equal(card(base({ type: "basic", front: "a", back: "b", priority: 9 })).tier, 2);
		assert.equal(card(base({ type: "basic", front: "a", back: "b", priority: undefined })).tier, 2);
		const c = card(base({ type: "basic", front: "a", back: "b", include: undefined }));
		assert.equal(c.include, true);
		assert.equal(card(base({ type: "basic", front: "a", back: "b", include: false })).include, false);
	});

	it("an image the card has: the part of the page, where it sits, the file", () => {
		const c = card(base({ type: "basic", front: "a", back: "b", image: { bbox: [0.1, 0.1, 0.9, 0.9], where: "extra", file: "img.png" } }));
		assert.deepEqual(c.image, { bbox: [0.1, 0.1, 0.9, 0.9], where: "extra", file: "img.png" });
		assert.equal(card(base({ type: "basic", front: "a", back: "b", image: { bbox: [0, 0, 1, 1], where: "front" } })).image?.file, null, "not rendered yet");
		assert.equal(card(base({ type: "basic", front: "a", back: "b", image: { where: "front" } })).image, null, "no part of the page: no image");
	});

	it("a figure cloze (the atlas mode) keeps its gaps' boxes", () => {
		const c = card(base({ type: "cloze", legend_cloze: true, text: "1 {{c1::Body}}\n2 {{c2::Head}}", marker_boxes: { "1": [0.1, 0.4, 0.2, 0.5], "2": [0.5, 0.2, 0.6, 0.3], "3": "junk" } }));
		assert.equal(c.type, "cloze");
		if (c.type !== "cloze") return;
		assert.equal(c.legendCloze, true);
		assert.equal(c.text, "1 {{c1::Body}}\n2 {{c2::Head}}");
		assert.deepEqual(Object.keys(c.markerBoxes), ["1", "2"]);
		assert.deepEqual(c.markerNums, {});
	});

	it("an occlusion card keeps its masks, pictures, hash and mask version as they were", () => {
		const c = card(occlusion()) as OcclusionCard;
		assert.equal(c.type, "image_occlusion");
		assert.equal(c.tier, 2);
		assert.equal(c.header, "Name the hidden label");
		assert.equal(c.mode, "one");
		assert.deepEqual(c.figureBbox, [0, 0, 1, 1]);
		assert.equal(c.maskExact, true);
		assert.equal(c.figureExact, false);
		assert.equal(c.label, "Tibia");
		assert.deepEqual(c.boxes, [[0.1, 0.1, 0.2, 0.15]]);
		assert.equal(c.allBoxes.length, 2);
		assert.equal(c.needsCheck, true);
		assert.equal(c.autoLegend, true);
		assert.equal(c.questionFile, "io_p003-c02_q_aa.jpg");
		assert.equal(c.answerFile, "io_p003-c02_a_bb.jpg");
		assert.equal(c.figHash, "ab".repeat(32));
		assert.equal(c.maskV, 2);
		assert.equal(c.note, "from the legend");
		assert.equal(c.markerBbox, null);
		assert.deepEqual(legacyMediaOf(c), ["io_p003-c02_q_aa.jpg", "io_p003-c02_a_bb.jpg"]);
	});

	it("an occlusion card without all_boxes covers its own mask; without a hash or version it has none", () => {
		const c = card(occlusion({ all_boxes: undefined, fig_hash: undefined, mask_v: undefined, auto_legend: undefined })) as OcclusionCard;
		assert.deepEqual(c.allBoxes, c.boxes);
		assert.equal("figHash" in c, false);
		assert.equal("maskV" in c, false);
		assert.equal("autoLegend" in c, false);
	});

	it("what cannot come along is kept with its reason: an old plain cloze, an unknown type, a card without text, an occlusion without a figure", () => {
		const cases: [unknown, RegExp][] = [
			[base({ type: "cloze", text: "x {{c1::y}}", deleted: true }), /old cloze/i],
			[base({ type: "cloze", legend_cloze: true }), /without its text/],
			[base({ type: "hologram" }), /unknown card type "hologram"/],
			[base({ type: "basic", front: "only a question" }), /without its text/],
			[occlusion({ figure_bbox: null }), /without its figure/],
			[base({ type: "basic", front: "a", back: "b", id: "" }), /without an id/],
			["not a card", /Not a card/],
		];
		for (const [raw, why] of cases) {
			const out = legacyCard(raw, 3);
			assert.ok("dropped" in out, `dropped: ${why}`);
			assert.match(out.dropped.reason, why);
			assert.deepEqual(out.dropped.raw, raw);
		}
	});

	it("legacyMediaOf names the picture of a front/back card, nothing for one without", () => {
		assert.deepEqual(legacyMediaOf(card(base({ type: "basic", front: "a", back: "b", image: { bbox: [0, 0, 1, 1], where: "front", file: "x.jpg" } }))), ["x.jpg"]);
		assert.deepEqual(legacyMediaOf(card(base({ type: "basic", front: "a", back: "b" }))), []);
	});
});

describe("legacyPageResult / legacyPageEntry", () => {
	const page = {
		page: 3,
		page_type: "abbildung",
		skip: false,
		skip_reason: "",
		topic: "Tibia and fibula",
		status: "done",
		dropped: [{ reason: "Too long", raw: { front: "x" } }],
		cards: [base({ type: "basic", front: "a", back: "b" }), base({ id: "p003-c05", type: "cloze", text: "x {{c1::y}}", deleted: true }), occlusion({ deleted: true })],
	};

	it("a page: its cards, the model's own dropped ones, and the ones that could not come along", () => {
		const r = legacyPageResult(page, 3)!;
		assert.equal(r.page, 3);
		assert.equal(r.pageType, "abbildung");
		assert.equal(r.topic, "Tibia and fibula");
		assert.equal(r.status, "done");
		assert.equal(r.skip, false);
		assert.equal(r.cards.length, 2);
		assert.equal(r.dropped.length, 2);
		assert.equal(r.dropped[0]!.reason, "Too long");
		assert.match(r.dropped[1]!.reason, /old cloze/i);
	});

	it("a page MedAnki left out stays skipped, with its reason", () => {
		const r = legacyPageResult({ page: 1, page_type: "titel", skip: true, skip_reason: "Title page", topic: "Cover", cards: [], dropped: [], status: "skipped" }, 1)!;
		assert.equal(r.status, "skipped");
		assert.equal(r.skip, true);
		assert.equal(r.skipReason, "Title page");
	});

	it("is null for what is not a page file", () => {
		assert.equal(legacyPageResult(null, 1), null);
		assert.equal(legacyPageResult({ page: 1 }, 1), null);
	});

	it("the job's counters: live cards, adopted ones, the model's title and whether the page was left out", () => {
		const r = legacyPageResult(page, 3)!;
		r.cards[0]!.adopted = { courseId: "c", cardId: "k", at: "t" };
		assert.deepEqual(legacyPageEntry({ status: "done" }, r), { status: "done", count: 1, adopted: 1, topic: "Tibia and fibula", skipped: false });
	});

	it("a page without a result file keeps MedAnki's own status", () => {
		assert.deepEqual(legacyPageEntry({ status: "pending", error: null, topic: "T" }, null), { status: "pending", count: 0, adopted: 0, topic: "T" });
		assert.deepEqual(legacyPageEntry({ status: "error", error: "boom" }, null), { status: "error", error: "boom", count: 0, adopted: 0 });
		assert.equal(legacyPageEntry({ status: "skipped" }, null).status, "done");
		assert.equal(legacyPageEntry(undefined, null).status, "pending");
	});
});

describe("legacyLayout", () => {
	const raw = {
		width_pt: 612,
		height_pt: 680.5,
		lines: [
			{ id: "L1", text: "82", bbox: [0.1, 0.1, 0.2, 0.15], tight: [0.1, 0.11, 0.2, 0.14], size: 9, src: "pdf", bold: false, italic: true, underline: false, in_figure: true },
			{ id: "G1", text: "Body", bbox: [0.5, 0.5, 0.6, 0.55], tight: null, size: 8, src: "legend", bold: true, italic: false, underline: true, in_figure: false, marker: "1", legend: "LG1", line: "L9", words: [{ t: "Body", b: [0.5, 0.5, 0.6, 0.55] }, { t: 7 }] },
			{ id: "bad", text: "no box" },
		],
		figures: [{ id: "F1", kind: "raster", bbox: [0, 0, 0.5, 0.5], legends: ["LG1"] }, { id: "F2", kind: "vector", bbox: [0.5, 0.5, 1, 1] }],
		chars: 4953,
		title: "Sacro-iliac joint",
		legends: [{ id: "LG1", kind: "numbered", figure: "F1", bbox: [0.1, 0.4, 0.3, 0.6], entries: ["G1"], markers_in_figure: 15, confident: true }],
	};

	it("snake_case becomes camelCase, the ids stay (the cards' source ids point at them)", () => {
		const l = legacyLayout(raw)!;
		assert.equal(l.widthPt, 612);
		assert.equal(l.heightPt, 680.5);
		assert.deepEqual(l.lines.map((x) => x.id), ["L1", "G1"], "a line without a box is left out");
		assert.equal(l.lines[0]!.inFigure, true);
		assert.equal(l.lines[0]!.italic, true);
		assert.deepEqual(l.lines[0]!.tight, [0.1, 0.11, 0.2, 0.14]);
		assert.equal(l.lines[1]!.src, "legend");
		assert.equal(l.lines[1]!.tight, null);
		assert.equal(l.lines[1]!.marker, "1");
		assert.equal(l.lines[1]!.legend, "LG1");
		assert.equal(l.lines[1]!.line, "L9");
		assert.deepEqual(l.lines[1]!.words, [{ t: "Body", b: [0.5, 0.5, 0.6, 0.55] }]);
		assert.deepEqual(l.figures, [{ id: "F1", kind: "raster", bbox: [0, 0, 0.5, 0.5], legends: ["LG1"] }, { id: "F2", kind: "vector", bbox: [0.5, 0.5, 1, 1] }]);
		assert.deepEqual(l.legends, [{ id: "LG1", kind: "numbered", figure: "F1", bbox: [0.1, 0.4, 0.3, 0.6], entries: ["G1"], markersInFigure: 15, confident: true }]);
		assert.equal(l.chars, 4953);
		assert.equal(l.title, "Sacro-iliac joint");
	});

	it("a layout without legends is fine (older files), and what is not a layout is null", () => {
		assert.deepEqual(legacyLayout({ ...raw, legends: undefined })!.legends, []);
		assert.equal(legacyLayout(null), null);
		assert.equal(legacyLayout({ lines: [] }), null);
	});
});

describe("job-level helpers", () => {
	it("glossary: only terms with a canonical spelling", () => {
		assert.deepEqual(legacyGlossary([{ canonical: "Articulatio coxae", variants: ["Hip joint", 3] }, { canonical: "" }, "x"]), [{ canonical: "Articulatio coxae", variants: ["Hip joint"] }]);
		assert.deepEqual(legacyGlossary(undefined), []);
	});
	it("headings are by position in the page range", () => {
		assert.deepEqual(legacyHeadings(["One", "", "Three"], 1), { "1": "One", "3": "Three" });
		assert.deepEqual(legacyHeadings(["A", "B"], 5), { "5": "A", "6": "B" });
		assert.deepEqual(legacyHeadings(undefined, 1), {});
	});
	it("a job stays done only if its run had finished", () => {
		assert.equal(legacyJobState("done"), "done");
		for (const s of ["interrupted", "stopped", "running", "queued", undefined]) assert.equal(legacyJobState(s), "stopped");
	});
});
