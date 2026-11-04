/** From draft to study card (src/core/card-adopt.ts), the mask inputs of the pictures (card-media.ts) and the figure hash (image-hash.ts). */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftToStudyCards, fmt, fmtClozeColored, legendImageHtml, mediaOf, studyCardId, tagPart } from "../src/core/card-adopt.ts";
import { isMaskExact, maskInputs, maskModeOf } from "../src/core/card-media.ts";
import { hashDistance } from "../src/core/card-dedupe.ts";
import type { FrontBackCard, LegendClozeCard, OcclusionCard } from "../src/core/contracts/create-cards.ts";
import type { Raster } from "../src/core/contracts/page-layout.ts";
import { dhash } from "../src/core/image-hash.ts";
import { renderCard } from "./card-adopt-render.ts";

const base = { page: 3, tier: 2 as const, whyType: "", extra: "", evidence: "", tags: [] as string[], warnings: [] as string[], deleted: false, include: true, manual: false, sourceIds: [] as string[], sourceBbox: null, image: null };
const ctx = { jobId: "crt_x", jobName: "Anatomy Lecture 3.pdf", courseId: "c1", at: "2026-11-04T10:00:00.000Z" };

const front = (over: Partial<FrontBackCard> = {}): FrontBackCard => ({ ...base, id: "p003-c02", type: "basic", front: "What is <heat>?", back: "Energy & **work**", ...over });

const occ = (over: Partial<OcclusionCard> = {}): OcclusionCard => ({
	...base,
	id: "p003-c05",
	type: "image_occlusion",
	header: "Name it",
	mode: "one",
	figureBbox: [0.1, 0.1, 0.5, 0.5],
	figureExact: false,
	maskExact: false,
	label: "Nervus medianus[[en:median nerve]]",
	hint: "",
	boxes: [[0.2, 0.2, 0.3, 0.25]],
	markerBbox: null,
	allBoxes: [[0.2, 0.2, 0.3, 0.25], [0.3, 0.3, 0.4, 0.35]],
	needsCheck: false,
	questionFile: "io_p003-c05_q_abc12345.png",
	answerFile: "io_p003-c05_a_def67890.png",
	...over,
});

const atlas = (over: Partial<LegendClozeCard> = {}): LegendClozeCard => ({
	...base,
	id: "p003-c06",
	type: "cloze",
	text: "1 {{c1::Aorta}}\n2 {{c2::Vena cava}}\n3 {{c4::Atrium}}",
	legendCloze: true,
	markerBoxes: { "1": [0.1, 0.2, 0.15, 0.25] },
	markerNums: { "1": "1" },
	image: { bbox: [0, 0, 1, 1], where: "front", file: "img_p003-c06_aa11bb22.jpg" },
	...over,
});

describe("text to card HTML", () => {
	it("escapes, bolds, adds the Latin terms' English and breaks lines", () => {
		assert.equal(fmt("a < b & c > d\n**key** term"), "a &lt; b &amp; c &gt; d<br><b>key</b> term");
		assert.equal(fmt("Nervus medianus[[en:median nerve]]"), 'Nervus medianus <span class="latin-en">(median nerve)</span>');
		assert.equal(fmt(null), "");
		assert.equal(fmt("{{c1::x}}"), "{{c1::x}}");
	});

	it("colours each gap of a whole-figure cloze and keeps the numbers outside the gaps", () => {
		assert.equal(
			fmtClozeColored("1 {{c1::Aorta}}\n2 {{c2::Vena <cava>}}"),
			'1 {{c1::<span class="legend-gap" data-n="1" style="color:#1a6fd6">Aorta</span>}}<br>2 {{c2::<span class="legend-gap" data-n="2" style="color:#d6361a">Vena &lt;cava&gt;</span>}}',
		);
	});

	it("places a marker per gap behind the figure, or just the figure without markers", () => {
		assert.equal(legendImageHtml("f.png", {}), '<img src="f.png">');
		assert.equal(legendImageHtml(null, { "1": [0, 0, 1, 1] }), "");
		assert.equal(legendImageHtml("f.png", { "1": [0.1, 0.2, 0.15, 0.25] }), '<img src="f.png"><span class="legend-mark" data-n="1" data-box="0.1000,0.2000,0.1500,0.2500"></span>');
	});

	it("makes tag parts and card ids", () => {
		assert.equal(tagPart("Anatomy Lecture 3.pdf"), "Anatomy_Lecture_3_pdf");
		assert.equal(tagPart("  "), "Document");
		assert.equal(studyCardId("crt_x", "p003-c02"), "crt_crt_x_p003-c02");
		assert.equal(studyCardId("crt_x", "p003-c02", 1), "crt_crt_x_p003-c02_v1");
	});
});

describe("draft → study cards", () => {
	it("makes one basic card with Front/Back/Extra/Source, tags and the tier", () => {
		const [card, ...rest] = draftToStudyCards(front({ extra: "mnemonic", tags: ["Physics"], tier: 1 }), ctx);
		assert.equal(rest.length, 0);
		assert.deepEqual(card!.fields, { Front: "What is &lt;heat&gt;?", Back: "Energy &amp; <b>work</b>", Extra: "mnemonic", Source: "Anatomy Lecture 3.pdf · p. 3", Reverse: "" });
		assert.equal(card!.kind, "basic");
		assert.equal(card!.id, "crt_crt_x_p003-c02");
		assert.deepEqual(card!.tags, ["Create::Anatomy_Lecture_3_pdf::S003", "Physics"]);
		assert.equal(card!.core, true);
		assert.equal(card!.tier, 1);
		assert.equal(card!.variant, undefined);
		assert.deepEqual(card!.origin, { kind: "pdf", jobId: "crt_x", page: 3, draftId: "p003-c02" });
		assert.equal(card!.topic, "Anatomy Lecture 3.pdf");
		assert.equal(draftToStudyCards(front({ tier: 3 }), ctx)[0]!.core, false);
	});

	it("makes two cards for a reversed pair, sharing the fields", () => {
		const cards = draftToStudyCards(front({ type: "basic_reversed" }), ctx);
		assert.deepEqual(cards.map((c) => [c.id, c.variant]), [["crt_crt_x_p003-c02", 0], ["crt_crt_x_p003-c02_v1", 1]]);
		assert.equal(cards[0]!.fields.Reverse, "y");
		assert.deepEqual(cards[0]!.fields, cards[1]!.fields);
	});

	it("puts the picture before the question or under the answer, and tags a process card", () => {
		const inFront = draftToStudyCards(front({ type: "process", image: { bbox: [0, 0, 1, 1], where: "front", file: "img_a.jpg" } }), ctx)[0]!;
		assert.equal(inFront.fields.Front, 'What is &lt;heat&gt;?<br><img src="img_a.jpg">');
		assert.ok(inFront.tags.includes("Create::Process"));
		const under = draftToStudyCards(front({ extra: "note", image: { bbox: [0, 0, 1, 1], where: "extra", file: "img_b.jpg" } }), ctx)[0]!;
		assert.equal(under.fields.Extra, 'note<br><img src="img_b.jpg">');
		const noFile = draftToStudyCards(front({ image: { bbox: [0, 0, 1, 1], where: "front", file: null } }), ctx)[0]!;
		assert.equal(noFile.fields.Front, "What is &lt;heat&gt;?");
	});

	it("makes one cloze card per gap of a whole-figure cloze, numbered by the gap", () => {
		const cards = draftToStudyCards(atlas(), ctx);
		assert.deepEqual(cards.map((c) => [c.id, c.kind, c.variant]), [["crt_crt_x_p003-c06", "cloze", 0], ["crt_crt_x_p003-c06_v1", "cloze", 1], ["crt_crt_x_p003-c06_v2", "cloze", 3]]);
		assert.equal(cards[0]!.fields.LegendCloze, "1");
		assert.ok(cards[0]!.fields.Text!.startsWith('<img src="img_p003-c06_aa11bb22.jpg"><span class="legend-mark" data-n="1"'));
	});

	it("makes an occlusion card from the two rendered pictures, and none before they exist", () => {
		const [card] = draftToStudyCards(occ({ hint: "left side" }), ctx);
		assert.equal(card!.kind, "occlusion");
		assert.deepEqual(card!.fields, {
			Header: "Name it",
			QuestionImage: '<img src="io_p003-c05_q_abc12345.png">',
			AnswerImage: '<img src="io_p003-c05_a_def67890.png">',
			Answer: 'Nervus medianus <span class="latin-en">(median nerve)</span><br><small>left side</small>',
			Extra: "",
			Source: "Anatomy Lecture 3.pdf · p. 3",
		});
		assert.deepEqual(draftToStudyCards(occ({ questionFile: null }), ctx), []);
	});

	it("lists the picture files a draft uses", () => {
		assert.deepEqual(mediaOf(occ()), ["io_p003-c05_q_abc12345.png", "io_p003-c05_a_def67890.png"]);
		assert.deepEqual(mediaOf(atlas()), ["img_p003-c06_aa11bb22.jpg"]);
		assert.deepEqual(mediaOf(front()), []);
	});

	it("renders every kind in the review screen's own renderer (no leftovers of the mapping)", () => {
		const rendered = [
			renderCard(draftToStudyCards(front(), ctx)[0]!, "back"),
			renderCard(draftToStudyCards(front({ type: "basic_reversed" }), ctx)[1]!, "front"),
			renderCard(draftToStudyCards(atlas(), ctx)[1]!, "front"),
			renderCard(draftToStudyCards(occ(), ctx)[0]!, "back"),
		];
		assert.match(rendered[0]!, /What is &lt;heat&gt;\?.*Energy &amp; <b>work<\/b>/s);
		assert.match(rendered[1]!, /^<div class="q">Energy &amp; <b>work<\/b><\/div>$/);
		assert.match(rendered[2]!, /bcsv-layout/);
		assert.match(rendered[2]!, /<span class="cloze">\[\.\.\.\]<\/span>/);
		assert.match(rendered[3]!, /median nerve/);
	});
});

describe("mask inputs", () => {
	it("calls a mask exact when drawn by hand, a box when estimated, else text", () => {
		assert.equal(maskModeOf(occ()), "text");
		assert.equal(maskModeOf(occ({ needsCheck: true })), "box");
		assert.equal(maskModeOf(occ({ maskExact: true })), "exact");
		assert.equal(maskModeOf(occ({ manual: true })), "exact");
		assert.equal(isMaskExact(occ({ edited: true, sourceIds: [] })), true);
		assert.equal(isMaskExact(occ({ edited: true, sourceIds: ["L1"] })), false);
	});

	it("gives figure-local targets, the other masks of the figure as context, and their own modes", () => {
		const a = occ();
		const b = occ({ id: "p003-c06", boxes: [[0.3, 0.3, 0.4, 0.35]], maskExact: true });
		const inputs = maskInputs(a, [a, b]);
		assert.deepEqual(inputs.targets.map((t) => t.map((v) => Math.round(v * 1e4) / 1e4)), [[0.25, 0.25, 0.5, 0.375]]);
		assert.deepEqual(inputs.others.map((t) => t.map((v) => Math.round(v * 1e4) / 1e4)), [[0.5, 0.5, 0.75, 0.625]]);
		assert.deepEqual(inputs.targetModes, ["text"]);
		assert.deepEqual(inputs.otherModes, ["exact"]);
		assert.deepEqual(maskInputs(a, [a]).otherModes, ["text"]); // a neighbour not on the page list: plain text mask
	});
});

describe("figure hash", () => {
	const raster = (w: number, h: number, f: (x: number, y: number) => number): Raster => {
		const data = new Uint8ClampedArray(w * h * 4);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const v = f(x, y);
				data.set([v, v, v, 255], (y * w + x) * 4);
			}
		}
		return { width: w, height: h, data };
	};
	// a figure with structure: dark blobs on light ground
	const figure = (x: number, y: number, s = 1): number => (Math.sin((x / s) * 0.31) * Math.cos((y / s) * 0.23) > 0.2 ? 40 : 220);

	it("is 64 hex characters and stable", () => {
		const a = dhash(raster(160, 120, figure));
		assert.match(a, /^[0-9a-f]{64}$/);
		assert.equal(dhash(raster(160, 120, figure)), a);
	});

	it("recognises the same figure at another resolution, and tells another figure apart", () => {
		const a = dhash(raster(160, 120, figure));
		const scaled = dhash(raster(320, 240, (x, y) => figure(x / 2, y / 2)));
		const other = dhash(raster(160, 120, (x, y) => (Math.sin(x * 0.9) * Math.sin(y * 0.7) > 0 ? 30 : 230)));
		assert.ok(hashDistance(a, scaled) <= 26, `same figure: ${hashDistance(a, scaled)}`);
		assert.ok(hashDistance(a, other) > 26, `other figure: ${hashDistance(a, other)}`);
	});
});
