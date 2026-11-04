import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StudyCard } from "../src/core/contracts/study.ts";
import {
	applyPicked,
	cardDocument,
	mcqCorrect,
	mcqSuggestedGrade,
	renderCloze,
	renderFace,
	resolveMedia,
} from "../src/core/study-render.ts";

const resolve = (name: string): string | null => (name === "gone.png" ? null : `data:x/${encodeURIComponent(name)}`);

const make = (over: Partial<StudyCard>): StudyCard => ({
	id: "c1",
	courseId: "k1",
	kind: "basic",
	fields: {},
	tags: [],
	core: false,
	origin: { kind: "manual" },
	createdAt: "2026-10-01T00:00:00.000Z",
	...over,
});

describe("study card rendering", () => {
	it("basic: front shows only the question, back adds answer, extra and source", () => {
		const c = make({ fields: { Front: "Q?", Back: "A!", Extra: "more", Source: "Skript S.4" } });
		const front = renderFace(c, "front", resolve);
		assert.match(front.html, /Q\?/);
		assert.doesNotMatch(front.html, /A!|more|Skript/);
		const back = renderFace(c, "back", resolve);
		assert.match(back.html, /Q\?[\s\S]*A!/);
		assert.match(back.html, /class="extra">more/);
		assert.match(back.html, /class="source">Skript S\.4/);
		assert.equal(back.split, false);
	});

	it("basic reverse variant swaps question and answer", () => {
		const c = make({ variant: 1, fields: { Front: "Q?", Back: "A!" } });
		assert.match(renderFace(c, "front", resolve).html, /A!/);
		assert.doesNotMatch(renderFace(c, "front", resolve).html, /Q\?/);
	});

	it("cloze: active gap hidden on the front, shown on the back, others stay visible", () => {
		const text = "{{c1::Ulnaris}} und {{c2::Radialis::Nerv}}";
		assert.equal(
			renderCloze(text, 1, "front", false),
			'<span class="cloze">[...]</span> und <span class="cloze-inactive">Radialis</span>',
		);
		assert.match(renderCloze(text, 2, "front", false), /\[Nerv\]/);
		assert.match(renderCloze(text, 1, "back", false), /<span class="cloze">Ulnaris<\/span>/);
		assert.match(renderCloze(text, 1, "front", true), /cloze-hidden">\[\.\.\.\]/);
	});

	it("cloze card uses the variant as the active number", () => {
		const c = make({ kind: "cloze", variant: 1, fields: { Text: "{{c1::A}} {{c2::B}}" } });
		const front = renderFace(c, "front", resolve).html;
		assert.match(front, /cloze">\[\.\.\.\]<\/span>/);
		assert.match(front, /cloze-inactive">A/);
	});

	it("media: relative src and [sound:] are resolved, remote/absolute stay, missing files degrade", () => {
		const out = resolveMedia(
			'<img src="a%20b.png"><img src="https://x/y.png"><img src="/abs.png"><img src="gone.png">[sound:dum.mp3][sound:gone.png]',
			resolve,
		);
		assert.match(out, /src="data:x\/a%20b\.png"/);
		assert.match(out, /src="https:\/\/x\/y\.png"/);
		assert.match(out, /src="\/abs\.png"/);
		assert.match(out, /<img src="data:,">/);
		assert.match(out, /<audio controls preload="none" src="data:x\/dum\.mp3">/);
		assert.match(out, /missing-media">\[sound missing: gone\.png\]/);
	});

	const BILD = make({
		kind: "cloze",
		variant: 1,
		fields: {
			Text:
				'<img src="arm.png">' +
				'<span class="legend-mark" data-n="1" data-box="0.1,0.2,0.3,0.4"></span>' +
				'<span class="legend-mark" data-n="2" data-box="0.5,0.5,0.75,0.9"></span><br>' +
				'<div>1: {{c1::<span class="legend-gap" data-n="1" style="color:red">Nervus ulnaris</span>}}</div>' +
				'<div>2: {{c2::<span class="legend-gap" data-n="2" style="color:blue">Nervus radialis</span>}}</div>',
			LegendCloze: "1",
			Extra: "Merkhilfe",
			Source: "Skript",
		},
	});

	it("Bildcloze: split layout with the active mark as a percent box over the figure", () => {
		const front = renderFace(BILD, "front", resolve);
		assert.equal(front.split, true);
		assert.match(front.html, /bcsv-imgwrap"><img src="data:x\/arm\.png">/);
		assert.match(front.html, /legend-mark" style="left:50%;top:50%;width:25%;height:40%"/);
		assert.doesNotMatch(front.html, /left:10%/); // the other gap's mark is not drawn
		assert.match(front.html, /cloze">\[\.\.\.\]/); // active gap hidden
		assert.match(front.html, /cloze-hidden">\[\.\.\.\]/); // other gap stays hidden
		assert.doesNotMatch(front.html, /Nervus radialis|Merkhilfe/);
	});

	it("Bildcloze back reveals the active gap and the tail", () => {
		const back = renderFace(BILD, "back", resolve);
		assert.match(back.html, /cloze"><span class="legend-gap"[^>]*>Nervus radialis/);
		assert.match(back.html, /class="extra">Merkhilfe/);
		assert.match(back.html, /class="source">Skript/);
	});

	it("Bildcloze with more than 8 gaps wraps the legend in two columns", () => {
		const gaps = Array.from({ length: 9 }, (_, i) => `<span class="legend-gap" data-n="${i + 1}">{{c${i + 1}::g${i}}}</span>`).join("");
		const c = make({ kind: "cloze", fields: { Text: `<img src="x.png">${gaps}`, LegendCloze: "1" } });
		assert.match(renderFace(c, "front", resolve).html, /bcsv-legend-grid/);
	});

	it("unsupported kinds say so instead of throwing", () => {
		const odd = make({ kind: "hologram" as StudyCard["kind"] });
		assert.match(renderFace(odd, "front", resolve).html, /not supported/);
	});

	const OCC = make({
		kind: "occlusion",
		fields: {
			Header: "Plexus",
			QuestionImage: '<img src="q.png">',
			AnswerImage: '<img src="a.png">',
			Answer: "Fasciculus lateralis",
			Extra: "Merkhilfe",
			Source: "Skript",
		},
	});

	it("occlusion: the front shows the masked image only, the back the unmasked one and the answer", () => {
		const front = renderFace(OCC, "front", resolve).html;
		assert.match(front, /class="header">Plexus/);
		assert.match(front, /src="data:x\/q\.png"/);
		assert.doesNotMatch(front, /a\.png|Fasciculus|Merkhilfe/);
		const back = renderFace(OCC, "back", resolve).html;
		assert.match(back, /src="data:x\/a\.png"/);
		assert.doesNotMatch(back, /q\.png/);
		assert.match(back, /Fasciculus lateralis/);
		assert.match(back, /class="extra">Merkhilfe/);
		assert.match(back, /class="source">Skript/);
	});

	const MCQ = make({
		kind: "mcq",
		fields: {
			Question: "Which nerve?",
			OptionA: "Ulnaris",
			OptionB: "Radialis",
			OptionC: "",
			OptionD: "Medianus",
			Correct: "B, D",
			Explanation: "Because.",
			Source: "Skript",
		},
	});

	it("mcq: the front lists the filled options without the key, the back marks the correct ones", () => {
		const front = renderFace(MCQ, "front", resolve).html;
		assert.match(front, /Which nerve\?/);
		assert.deepEqual([...front.matchAll(/data-key="([A-D])"/g)].map((m) => m[1]), ["A", "B", "D"]);
		assert.doesNotMatch(front, /data-ok|Because|Correct:/);
		const back = renderFace(MCQ, "back", resolve).html;
		assert.deepEqual([...back.matchAll(/data-key="([A-D])" data-ok/g)].map((m) => m[1]), ["B", "D"]);
		assert.match(back, /Correct: B, D/);
		assert.match(back, /Because\./);
		assert.match(back, /class="mcq-opts mcq-back" data-lh-picked=""/);
	});

	it("mcq: correct letters, suggested grade and the picked letters in the back", () => {
		assert.deepEqual(mcqCorrect(MCQ.fields), ["B", "D"]);
		assert.deepEqual(mcqCorrect({ Correct: "c" }), []); // letters are upper case
		assert.equal(mcqSuggestedGrade(["B", "D"], ["D", "B"]), 3);
		assert.equal(mcqSuggestedGrade(["B", "D"], ["B"]), 1);
		assert.equal(mcqSuggestedGrade(["B", "D"], ["B", "D", "A"]), 1);
		assert.equal(mcqSuggestedGrade(["B"], []), 1);
		assert.equal(mcqSuggestedGrade([], ["A"]), 3); // nothing to check against
		const back = renderFace(MCQ, "back", resolve).html;
		assert.match(applyPicked(back, ["A", "B", "B", "X", '"><b>']), /data-lh-picked="A B"/);
		assert.match(applyPicked(back, []), /data-lh-picked=""/);
	});

	it("the iframe document is script-free unless an MCQ front passes a nonce — then only that script runs", () => {
		const doc = cardDocument("<p>x</p>", { dark: false, mcqNonce: "abc123" });
		assert.match(doc, /script-src 'nonce-abc123'/);
		assert.match(doc, /<script nonce="abc123">/);
		assert.equal((doc.match(/<script/g) ?? []).length, 1);
		assert.equal(/script-src [^;"]*/.exec(doc)?.[0], "script-src 'nonce-abc123'");
		assert.doesNotMatch(cardDocument("<p>x</p>", { dark: false }), /script-src|<script/);
	});

	it("the iframe document carries a CSP that allows only data: media", () => {
		const doc = cardDocument("<p>x</p>", { dark: true });
		assert.match(doc, /Content-Security-Policy/);
		assert.match(doc, /default-src 'none'; img-src data:; media-src data:/);
		assert.doesNotMatch(doc, /<script/i);
		assert.match(doc, /<html class="dark">/);
		assert.match(doc, /<div class="card"><p>x<\/p><\/div>/);
		const split = cardDocument('<div class="bcsv-layout">y</div>', { dark: false });
		assert.doesNotMatch(split, /<div class="card"><div class="bcsv-layout"/);
	});
});
