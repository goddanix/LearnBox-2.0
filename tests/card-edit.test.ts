/**
 * Editing draft cards, cards by hand, moving masks (src/core/card-edit.ts) and the candidates for Claude's
 * content check of duplicates (src/core/card-dedupe.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boxBetween, handlePoint, HANDLES, isDrawn, MIN_SIDE, moveBox, resizeBox } from "../src/core/box-edit.ts";
import { applyCardEdit, applyImageEdit, applyMaskEdit, buildManualCard, CardEditError, nextCardIndex } from "../src/core/card-edit.ts";
import { dedupeBrief, weakCandidates } from "../src/core/card-dedupe.ts";
import type { CardDraft, FrontBackCard, OcclusionCard } from "../src/core/contracts/create-cards.ts";
import type { Box, PageLayout, PageLine } from "../src/core/contracts/page-layout.ts";

function line(id: string, text: string, bbox: Box): PageLine {
	return { id, text, bbox, tight: null, size: 10, src: "pdf", bold: false, italic: false, underline: false, inFigure: false };
}

const layout: PageLayout = {
	widthPt: 600,
	heightPt: 800,
	lines: [line("L1", "Aorta", [0.2, 0.2, 0.3, 0.23])],
	figures: [{ id: "F1", kind: "raster", bbox: [0.1, 0.1, 0.9, 0.7] }],
	legends: [],
	chars: 5,
	title: "",
};
const SETTINGS = { language: "en", ioMode: "auto" } as const;

const baseInit = (over: Record<string, unknown> = {}) => ({
	page: 1,
	tier: 2 as const,
	whyType: "",
	extra: "",
	evidence: "",
	tags: [] as string[],
	warnings: [] as string[],
	deleted: false,
	include: true,
	manual: false,
	sourceIds: [] as string[],
	sourceBbox: null,
	image: null,
	...over,
});

const basic = (id: string, front: string, back: string, over: Partial<FrontBackCard> = {}): FrontBackCard =>
	({ ...baseInit(), id, type: "basic", front, back, ...over }) as FrontBackCard;

function mask(id: string, label: string, box: Box, over: Partial<OcclusionCard> = {}): OcclusionCard {
	return {
		...baseInit(),
		id,
		type: "image_occlusion",
		header: "Name it",
		mode: "one",
		figureBbox: [0.1, 0.1, 0.5, 0.5],
		figureExact: false,
		maskExact: false,
		label,
		hint: "",
		boxes: [box],
		markerBbox: null,
		allBoxes: [box],
		needsCheck: true,
		questionFile: "q.png",
		answerFile: "a.png",
		sourceIds: ["L1"],
		warnings: ["Mask from an estimated box — please check the picture"],
		...over,
	} as OcclusionCard;
}

describe("editing a card", () => {
	it("changes texts, tier and tags, marks the card edited and checks the quality again", () => {
		const c = basic("p001-c01", "Old question?", "Old answer");
		applyCardEdit(c, { front: "  New <b>question</b>?  ", back: "New answer", tier: "1", tags: "heart, aorta" });
		assert.equal(c.front, "New question?");
		assert.equal(c.back, "New answer");
		assert.equal(c.tier, 1);
		assert.deepEqual(c.tags, ["heart", "aorta"]);
		assert.equal(c.edited, true);
	});

	it("keeps the Mask warnings but redoes the quality warnings", () => {
		const c = basic("p001-c01", "Q?", "A", { warnings: ["Mask from an estimated box — please check the picture", "stale"] });
		applyCardEdit(c, { back: "A longer answer" });
		assert.deepEqual(c.warnings.filter((w) => w.startsWith("Mask")).length, 1);
		assert.equal(c.warnings.includes("stale"), false);
	});

	it("refuses an empty side, a broken gap text and an invalid tier — and changes nothing", () => {
		const c = basic("p001-c01", "Q?", "A");
		assert.throws(() => applyCardEdit(c, { front: "New?", back: "  " }), CardEditError);
		assert.throws(() => applyCardEdit(c, { front: "New?", tier: "high" }), /importance/);
		assert.deepEqual([c.front, c.back, c.edited], ["Q?", "A", undefined]);
		const gap = { ...baseInit(), id: "p001-c02", type: "cloze", text: "The {{c1::aorta}} leaves", legendCloze: true, markerBoxes: {}, markerNums: {} } as CardDraft;
		assert.throws(() => applyCardEdit(gap, { text: "no gap here" }), /gap text/);
		assert.equal((gap as { text: string }).text, "The {{c1::aorta}} leaves");
	});

	it("ignores fields a card does not have", () => {
		const c = basic("p001-c01", "Q?", "A");
		applyCardEdit(c, { text: "x {{c1::y}}", header: "h", label: "l" });
		assert.equal("text" in c, false);
		assert.equal("header" in c, false);
		assert.equal(c.edited, undefined);
	});

	it("lets an occlusion have an empty answer label", () => {
		const m = mask("p001-c01", "Aorta", [0.2, 0.2, 0.3, 0.25]);
		applyCardEdit(m, { label: "" });
		assert.equal(m.label, "");
	});

	it("throws away and restores — a restored card is never removed again by the machine", () => {
		const c = basic("p001-c01", "Q?", "A");
		applyCardEdit(c, { deleted: true });
		assert.equal(c.deleted, true);
		assert.equal(c.note, "Deleted by hand");
		applyCardEdit(c, { deleted: false });
		assert.equal(c.deleted, false);
		assert.equal(c.restored, true);
		assert.equal("note" in c, false);
		assert.equal(c.edited, undefined); // restoring is not editing the text
	});

	it("selects and unselects", () => {
		const c = basic("p001-c01", "Q?", "A");
		applyCardEdit(c, { include: false });
		assert.equal(c.include, false);
		applyCardEdit(c, { include: true });
		assert.equal(c.include, true);
	});
});

describe("cards by hand", () => {
	it("makes a question/answer card that is the learner's own", () => {
		const { card, reason } = buildManualCard({ type: "basic", front: "What is the aorta?", back: "The largest artery", tier: 1, tags: "heart" }, layout, 3, 7, SETTINGS);
		assert.equal(reason, "");
		assert.ok(card);
		assert.equal(card.id, "p003-c07");
		assert.equal(card.manual, true);
		assert.equal(card.tier, 1);
		assert.deepEqual(card.tags, ["heart"]);
		assert.equal(card.page, 3);
		assert.equal(card.include, true);
	});

	it("also makes a reversed card and refuses unknown types and empty sides, each with a reason", () => {
		assert.ok(buildManualCard({ type: "basic_reversed", front: "Aorta", back: "Largest artery" }, layout, 1, 1, SETTINGS).card);
		assert.match(buildManualCard({ type: "cloze", front: "a", back: "b" }, layout, 1, 1, SETTINGS).reason, /Unknown or unsupported/);
		const empty = buildManualCard({ type: "basic", front: "Q?", back: " " }, layout, 1, 1, SETTINGS);
		assert.equal(empty.card, null);
		assert.ok(empty.reason.length > 0);
	});

	it("makes an occlusion over the area the learner drew, exactly as drawn", () => {
		const { card, reason } = buildManualCard({ type: "image_occlusion", label: "Aorta", bbox: [0.2, 0.2, 0.7, 0.6] }, layout, 2, 4, SETTINGS);
		assert.equal(reason, "");
		assert.ok(card && card.type === "image_occlusion");
		assert.equal(card.id, "p002-c04");
		assert.equal(card.manual, true);
		assert.equal(card.maskExact, true);
		assert.equal(card.needsCheck, false);
		assert.deepEqual(card.warnings, []);
		assert.equal(card.label, "Aorta");
		assert.equal(card.header, "Name the marked structure");
	});

	it("keeps a figure the learner chose; needs a drawn area", () => {
		const chosen = buildManualCard({ type: "image_occlusion", label: "Aorta", bbox: [0.2, 0.2, 0.3, 0.3], figure: { bbox: [0.1, 0.1, 0.6, 0.6] } }, layout, 1, 1, SETTINGS).card as OcclusionCard;
		assert.equal(chosen.figureExact, true);
		const none = buildManualCard({ type: "image_occlusion", label: "Aorta" }, layout, 1, 1, SETTINGS);
		assert.equal(none.card, null);
		assert.match(none.reason, /select the area/);
	});

	it("numbers on from the highest card of the page", () => {
		assert.equal(nextCardIndex([]), 1);
		assert.equal(nextCardIndex([basic("p001-c01", "a", "b"), basic("p001-c05", "c", "d"), basic("p001-c02", "e", "f")]), 6);
	});
});

describe("moving a mask", () => {
	const figure: Box = [0.1, 0.1, 0.5, 0.5];

	it("places the mask exactly, drops the line behind it and grows the picture to hold it", () => {
		const a = mask("p001-c01", "Aorta", [0.2, 0.2, 0.3, 0.25], { figureBbox: figure });
		const b = mask("p001-c02", "Vena", [0.3, 0.3, 0.4, 0.35], { figureBbox: figure, sourceIds: ["L2"] });
		const out = applyMaskEdit([a, b], "p001-c01", { bbox: [0.55, 0.2, 0.65, 0.25] });
		assert.ok(out);
		assert.equal(out.target, a);
		assert.deepEqual(out.group.map((c) => c.id), ["p001-c01", "p001-c02"]);
		assert.deepEqual(a.boxes, [[0.55, 0.2, 0.65, 0.25]]);
		assert.equal(a.maskExact, true);
		assert.equal(a.needsCheck, false);
		assert.deepEqual(a.sourceIds, []);
		assert.deepEqual(a.warnings, []);
		assert.equal(a.edited, true);
		// the picture of the whole group now reaches the moved mask
		assert.ok(a.figureBbox[2] >= 0.65);
		assert.deepEqual(a.figureBbox, b.figureBbox);
		assert.deepEqual(b.allBoxes, [a.boxes[0], b.boxes[0]]);
	});

	it("never shrinks an automatic picture, but a chosen part may shrink around the masks", () => {
		const a = mask("p001-c01", "Aorta", [0.2, 0.2, 0.3, 0.25], { figureBbox: figure });
		applyMaskEdit([a], "p001-c01", { bbox: [0.21, 0.2, 0.31, 0.25] });
		assert.deepEqual(a.figureBbox, figure);
		assert.equal(a.figureExact, false);
		applyMaskEdit([a], "p001-c01", { figure: [0.15, 0.15, 0.4, 0.4] });
		assert.equal(a.figureExact, true);
		assert.ok(a.figureBbox[0] >= 0.15 - 1e-9 && a.figureBbox[2] <= 0.4 + 0.01);
		assert.ok(a.figureBbox[2] < figure[2]);
	});

	it("a chosen picture cannot shrink so far that a mask falls out", () => {
		const a = mask("p001-c01", "Aorta", [0.2, 0.2, 0.3, 0.25], { figureBbox: figure });
		applyMaskEdit([a], "p001-c01", { figure: [0.4, 0.4, 0.45, 0.45] });
		assert.ok(a.figureBbox[0] <= 0.2 && a.figureBbox[1] <= 0.2 && a.figureBbox[2] >= 0.3 && a.figureBbox[3] >= 0.25);
	});

	it("refuses a missing card, a card without a mask, and invalid or empty requests", () => {
		const a = mask("p001-c01", "Aorta", [0.2, 0.2, 0.3, 0.25]);
		const q = basic("p001-c02", "Q?", "A");
		assert.equal(applyMaskEdit([a, q], "p001-c09", { bbox: [0.2, 0.2, 0.3, 0.25] }), null);
		assert.equal(applyMaskEdit([a, q], "p001-c02", { bbox: [0.2, 0.2, 0.3, 0.25] }), null);
		assert.equal(applyMaskEdit([a], "p001-c01", { bbox: [0.5, 0.5, 0.4, 0.4] }), null);
		assert.equal(applyMaskEdit([a], "p001-c01", {}), null);
		assert.deepEqual(a.boxes, [[0.2, 0.2, 0.3, 0.25]]);
	});
});

describe("the shown part of a picture", () => {
	it("changes the box and returns the file to remove", () => {
		const c = basic("p001-c01", "Q?", "A", { image: { bbox: [0.1, 0.1, 0.5, 0.5], where: "front", file: "old.png" } } as Partial<FrontBackCard>);
		const out = applyImageEdit([c], "p001-c01", [0.2, 0.2, 0.6, 0.6]);
		assert.equal(out?.oldFile, "old.png");
		assert.deepEqual(c.image?.bbox, [0.2, 0.2, 0.6, 0.6]);
		assert.equal(c.edited, true);
		assert.equal(applyImageEdit([c], "p001-c01", [0.6, 0.6, 0.2, 0.2]), null);
		assert.equal(applyImageEdit([basic("p001-c02", "a", "b")], "p001-c02", [0.2, 0.2, 0.6, 0.6]), null);
	});
});

describe("candidates for the content check", () => {
	it("shows Claude only the text of a card", () => {
		assert.deepEqual(dedupeBrief(basic("p001-c01", "Q?", "A")), { id: "p001-c01", type: "basic", front: "Q?", back: "A" });
		assert.deepEqual(dedupeBrief(mask("p001-c02", "Aorta", [0.2, 0.2, 0.3, 0.25])), { id: "p001-c02", type: "image_occlusion", header: "Name it", label: "Aorta" });
	});

	it("proposes similar-but-not-identical questions, but not the sure duplicates or unrelated cards", () => {
		const a = basic("p001-c01", "Which artery supplies the right ventricle wall?", "The right coronary artery");
		const b = basic("p001-c02", "Which vessel feeds the wall of the right ventricle?", "Right coronary artery");
		const same = basic("p001-c03", "What pumps blood?", "The heart");
		const same2 = basic("p001-c04", "What pumps blood?", "The heart");
		const other = basic("p001-c05", "What is the normal resting pulse?", "60 to 100 per minute");
		const pairs = weakCandidates([{ cards: [a, b, same, same2, other] }], 0.9);
		const ids = pairs.map((p) => [p.a.id, p.b.id].sort().join("+"));
		assert.ok(ids.includes("p001-c01+p001-c02"), ids.join(" "));
		assert.equal(ids.includes("p001-c03+p001-c04"), false);
		assert.equal(ids.some((id) => id.includes("p001-c05")), false);
	});

	it("proposes the same label at a different place of a picture, skips the very same mask and deleted cards", () => {
		const a = mask("p001-c01", "Aorta", [0.2, 0.2, 0.3, 0.25]);
		const far = mask("p001-c02", "Aorta", [0.7, 0.7, 0.8, 0.75]);
		const same = mask("p001-c03", "Aorta", [0.2, 0.2, 0.3, 0.25]);
		const gone = mask("p001-c04", "Aorta", [0.4, 0.4, 0.5, 0.45], { deleted: true });
		const pairs = weakCandidates([{ cards: [a, far, same, gone] }], 0.9);
		const ids = pairs.map((p) => [p.a.id, p.b.id].sort().join("+"));
		assert.deepEqual(ids.sort(), ["p001-c01+p001-c02", "p001-c02+p001-c03"]);
		assert.ok(pairs.every((p) => p.kind === "occlusion"));
	});
});

describe("boxes on a page picture", () => {
	const round = (b: Box): Box => b.map((v) => Math.round(v * 1e4) / 1e4) as Box;

	it("spans a box between two points in any direction and keeps it on the page", () => {
		assert.deepEqual(boxBetween([0.5, 0.6], [0.2, 0.3]), [0.2, 0.3, 0.5, 0.6]);
		assert.deepEqual(boxBetween([-0.2, 0.3], [1.4, 0.9]), [0, 0.3, 1, 0.9]);
		assert.equal(isDrawn(boxBetween([0.3, 0.3], [0.3, 0.3])), false, "a click is not a box");
		assert.equal(isDrawn(boxBetween([0.3, 0.3], [0.4, 0.35])), true);
	});

	it("moves a box without changing its size and stops at the page edge", () => {
		assert.deepEqual(round(moveBox([0.2, 0.2, 0.4, 0.3], 0.1, -0.05)), [0.3, 0.15, 0.5, 0.25]);
		assert.deepEqual(round(moveBox([0.2, 0.2, 0.4, 0.3], 0.9, 0.9)), [0.8, 0.9, 1, 1]);
		assert.deepEqual(round(moveBox([0.2, 0.2, 0.4, 0.3], -0.9, -0.9)), [0, 0, 0.2, 0.1]);
	});

	it("resizes by one handle, keeping the opposite sides", () => {
		const box: Box = [0.2, 0.2, 0.4, 0.4];
		assert.deepEqual(round(resizeBox(box, "se", 0.1, 0.05)), [0.2, 0.2, 0.5, 0.45]);
		assert.deepEqual(round(resizeBox(box, "nw", -0.1, -0.1)), [0.1, 0.1, 0.4, 0.4]);
		assert.deepEqual(round(resizeBox(box, "e", 0.1, 0.5)), [0.2, 0.2, 0.5, 0.4], "a side handle moves one axis only");
		assert.deepEqual(round(resizeBox(box, "n", 0.5, 0.1)), [0.2, 0.3, 0.4, 0.4]);
	});

	it("never folds a box flat or off the page", () => {
		const box: Box = [0.2, 0.2, 0.4, 0.4];
		const folded = resizeBox(box, "e", -0.9, 0);
		assert.ok(folded[2] - folded[0] >= MIN_SIDE - 1e-9);
		assert.equal(folded[0], 0.2);
		assert.deepEqual(round(resizeBox(box, "se", 5, 5)), [0.2, 0.2, 1, 1]);
		assert.deepEqual(round(resizeBox(box, "nw", -5, -5)), [0, 0, 0.4, 0.4]);
	});

	it("names where each handle sits", () => {
		const box: Box = [0.2, 0.2, 0.6, 0.4];
		assert.deepEqual(handlePoint(box, "nw"), [0.2, 0.2]);
		assert.deepEqual(handlePoint(box, "se"), [0.6, 0.4]);
		const [x, y] = handlePoint(box, "n");
		assert.ok(Math.abs(x - 0.4) < 1e-9 && y === 0.2);
		assert.equal(HANDLES.length, 8);
	});
});
