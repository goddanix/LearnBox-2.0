import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DraftCard } from "../components/create/cards-job-detail.tsx";
import { LegacyImport } from "../components/create/legacy-import.tsx";
import { NewCardsForm } from "../components/create/new-cards-form.tsx";
import { NewJobForm } from "../components/create/new-job-form.tsx";
import type { LectureSource } from "../src/core/contracts.ts";
import type { CardDraft, FrontBackCard, LegendClozeCard, OcclusionCard } from "../src/core/contracts/create-cards.ts";

/**
 * The Create area's static surface (Learnbox 2.0, 2026-11): the new-job form's
 * controls and its "other PDF" choice, and the MedAnki import's dry-run-first
 * entry. Server-rendered, no network.
 */

const lecture = (id: string, title: string): LectureSource => ({
	v: 1,
	id,
	title,
	fileName: `${title}.pdf`,
	bytes: 1000,
	sha256: id,
	pages: 12,
	addedAt: "2026-11-04T10:00:00.000Z",
	status: "stored",
});

const noop = () => {};

describe("NewJobForm", () => {
	it("names the PDF and offers the settings, with English as the default language", () => {
		const html = renderToStaticMarkup(
			<NewJobForm lecture={lecture("a", "Vertebrae")} lectures={[lecture("a", "Vertebrae")]} onCreated={noop} onCancel={noop} />,
		);
		assert.match(html, /Multiple-choice test from <span[^>]*>Vertebrae<\/span>/);
		assert.match(html, /Questions per page/);
		assert.match(html, /<option value="en" selected="">English<\/option>/);
		assert.match(html, /<option value="de">German<\/option>/);
		assert.match(html, /To page \(0 = end\)/);
		assert.match(html, /Create questions/);
		assert.match(html, /Nothing is added to your cards until you adopt it/);
	});

	it("offers only OTHER library PDFs as the fact source, and none when there is no other", () => {
		const a = lecture("a", "Question sheet");
		const html = renderToStaticMarkup(<NewJobForm lecture={a} lectures={[a, lecture("b", "Lecture slides")]} onCreated={noop} onCancel={noop} />);
		assert.match(html, /<option value="b">Lecture slides<\/option>/);
		assert.doesNotMatch(html, /<option value="a">/);
		assert.match(html, /Facts from another PDF/);

		const alone = renderToStaticMarkup(<NewJobForm lecture={a} lectures={[a]} onCreated={noop} onCancel={noop} />);
		assert.doesNotMatch(alone, /Facts from another PDF/);
	});

	it("limits the page inputs to the PDF's pages", () => {
		const html = renderToStaticMarkup(<NewJobForm lecture={lecture("a", "X")} lectures={[]} onCreated={noop} onCancel={noop} />);
		assert.match(html, /max="12"/);
	});
});

describe("NewCardsForm", () => {
	it("names the PDF and offers MedAnki's card settings with English and normal as defaults", () => {
		const html = renderToStaticMarkup(<NewCardsForm lecture={lecture("a", "Cardiology")} onCreated={noop} onCancel={noop} />);
		assert.match(html, /Flashcards from <span[^>]*>Cardiology<\/span>/);
		assert.match(html, /<option value="normal" selected="">Normal<\/option>/);
		assert.match(html, /<option value="concept">Concept questions/);
		assert.match(html, /<option value="en" selected="">English<\/option>/);
		assert.match(html, /<option value="auto" selected="">Automatic \(by title\)<\/option>/);
		assert.match(html, /Atlas mode/);
		assert.match(html, /Vocabulary sheet of a language course/);
		assert.match(html, /max="12"/);
		assert.match(html, /Create cards/);
		assert.match(html, /Nothing is added to your cards until you adopt it/);
		assert.doesNotMatch(html, /Only these topics/, "the strict switch shows once there are topics");
		assert.doesNotMatch(html, /Course language/, "the course language shows with the vocabulary switch");
	});
});

const base = { page: 3, tier: 2 as const, whyType: "", extra: "", evidence: "", tags: [], warnings: [], deleted: false, include: true, manual: false, sourceIds: [], sourceBbox: null, image: null };
const media = (file: string) => `/m/${file}`;
const draft = (c: CardDraft) => renderToStaticMarkup(<DraftCard c={c} mediaUrl={media} selected onSelect={noop} onToggleDeleted={noop} />);

describe("DraftCard", () => {
	it("shows a question with its answer, bold and the Latin term's English addition, and the warnings", () => {
		const c: FrontBackCard = { ...base, id: "p003-c01", type: "basic", front: "Which nerve runs through the **carpal tunnel**?", back: "N. medianus [[en:median nerve]]", extra: "Compressed in carpal tunnel syndrome", warnings: ["Question is very long"] };
		const html = draft(c);
		assert.match(html, /Which nerve runs through the <b>carpal tunnel<\/b>\?/);
		assert.match(html, /N\. medianus <span[^>]*> \(median nerve\)<\/span>/);
		assert.match(html, /Compressed in carpal tunnel syndrome/);
		assert.match(html, /Question is very long/);
		assert.match(html, /Add this card to my cards/);
		assert.match(html, /Core|Good to know/);
	});

	it("never injects card text as HTML", () => {
		const c: FrontBackCard = { ...base, id: "p003-c01", type: "basic", front: "<img src=x onerror=alert(1)>", back: "<script>1</script>" };
		const html = draft(c);
		assert.doesNotMatch(html, /<img src=x/);
		assert.doesNotMatch(html, /<script>/);
		assert.match(html, /&lt;script&gt;/);
	});

	it("marks the gaps of a gap text and shows the figure", () => {
		const c: LegendClozeCard = { ...base, id: "p003-c02", type: "cloze", text: "1 {{c1::Aorta}}\n2 {{c2::Vena cava}}", legendCloze: true, markerBoxes: {}, markerNums: {}, image: { bbox: [0, 0, 1, 1], where: "front", file: "img_a.png" } };
		const html = draft(c);
		assert.match(html, /title="Gap 1"/);
		assert.match(html, /title="Gap 2"/);
		assert.match(html, /src="\/m\/img_a\.png"/);
		assert.doesNotMatch(html, /\{\{c1/);
	});

	it("shows both pictures of an occlusion card and says when the covered place is a guess", () => {
		const c = { ...base, id: "p003-c03", type: "image_occlusion", header: "Name the structure", mode: "one", figureBbox: [0, 0, 1, 1], figureExact: false, maskExact: false, label: "Aorta", hint: "", boxes: [], markerBbox: null, allBoxes: [], needsCheck: true, questionFile: "q.png", answerFile: "a.png" } as OcclusionCard;
		const html = draft(c);
		assert.match(html, /Name the structure/);
		assert.match(html, /Aorta/);
		assert.match(html, /src="\/m\/q\.png"/);
		assert.match(html, /src="\/m\/a\.png"/);
		assert.match(html, /The covered place is a guess/);
	});

	it("strikes a deleted card through with its reason and offers to bring it back; an adopted one is only labelled", () => {
		const gone: FrontBackCard = { ...base, id: "p003-c01", type: "basic", front: "Q", back: "A", deleted: true, note: "Duplicate of p001-c02" };
		const html = draft(gone);
		assert.match(html, /line-through/);
		assert.match(html, /Duplicate of p001-c02/);
		assert.match(html, /aria-label="Bring back"/);
		assert.doesNotMatch(html, /type="checkbox"/);

		const adopted: FrontBackCard = { ...base, id: "p003-c02", type: "basic", front: "Q", back: "A", adopted: { courseId: "c", cardId: "x", at: "2026-11-04T10:00:00.000Z" } };
		const done = draft(adopted);
		assert.match(done, /In your cards/);
		assert.doesNotMatch(done, /aria-label="Throw away"/);
	});
});

describe("LegacyImport", () => {
	it("starts closed and does nothing until Check is pressed", () => {
		const html = renderToStaticMarkup(<LegacyImport onImported={noop} />);
		assert.match(html, /<details[^>]*data-testid="legacy-import"/);
		assert.doesNotMatch(html, /<details[^>]* open/);
		assert.match(html, /MedAnki itself is not changed/);
		assert.match(html, /data-testid="legacy-check"/);
		assert.doesNotMatch(html, /legacy-import-button/);
		assert.doesNotMatch(html, /legacy-jobs/);
	});
});
