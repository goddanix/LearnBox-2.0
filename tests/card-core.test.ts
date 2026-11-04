/**
 * The card pipeline's pure rules (src/core/card-*.ts): cleaning the model's text, resolving occlusions,
 * finding duplicates, and turning a page answer into draft cards with their safety nets.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autoMark, DUPLICATE_NOTE, findGroups, hashDistance, keepRank } from "../src/core/card-dedupe.ts";
import { boxesForIds, expandOcclusion, expandWholeImage, indexLines, leadingNumber, mergeOcclusionGroups, nearbyNumberLabel } from "../src/core/card-occlusion.ts";
import { cardId, evidenceWarnings, isEvidenceWarning, normalizePage, qualityWarnings } from "../src/core/card-normalize.ts";
import { cleanTags, cleanText, clampBbox, clozeOk, clozePlain, jaccard, norm, resolveRegion, resolveSource, tokens, validBbox } from "../src/core/card-util.ts";
import type { CardDraft, FrontBackCard, OcclusionCard } from "../src/core/contracts/create-cards.ts";
import type { Box, PageLayout, PageLine } from "../src/core/contracts/page-layout.ts";

function line(id: string, text: string, bbox: Box, extra: Partial<PageLine> = {}): PageLine {
	return { id, text, bbox, tight: null, size: 10, src: "pdf", bold: false, italic: false, underline: false, inFigure: false, ...extra };
}

function layoutOf(lines: PageLine[], extra: Partial<PageLayout> = {}): PageLayout {
	return { widthPt: 600, heightPt: 800, lines, figures: [], legends: [], chars: lines.reduce((n, l) => n + l.text.length, 0), title: "", ...extra };
}

const SETTINGS = { vocab: false, wholeImageCards: false, language: "en", ioMode: "auto" } as const;

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

function basic(id: string, front: string, back: string, over: Partial<FrontBackCard> = {}): FrontBackCard {
	return { ...baseInit(), id, type: "basic", front, back, ...over } as FrontBackCard;
}

function occlusion(id: string, label: string, box: Box, over: Partial<OcclusionCard> = {}): OcclusionCard {
	return {
		...baseInit(),
		id,
		type: "image_occlusion",
		header: "Name it",
		mode: "one",
		figureBbox: [0.1, 0.1, 0.9, 0.9],
		figureExact: false,
		maskExact: false,
		label,
		hint: "",
		boxes: [box],
		markerBbox: null,
		allBoxes: [box],
		needsCheck: false,
		questionFile: null,
		answerFile: null,
		...over,
	} as OcclusionCard;
}

describe("card-util", () => {
	it("cleans model text of HTML leftovers", () => {
		assert.equal(cleanText("  a<br/>b <b>bold</b> <span class='x'>s</span>\r"), "a\nb bold s");
		assert.equal(cleanText(null), "");
		assert.equal(cleanText(12), "12");
	});

	it("checks cloze syntax", () => {
		assert.equal(clozeOk("The {{c1::heart}} pumps").ok, true);
		assert.equal(clozeOk("no gap").ok, false);
		assert.equal(clozeOk("{{c1::a}} and {{c2::b").ok, false);
		assert.equal(clozePlain("The {{c1::heart::organ}} pumps"), "The heart pumps");
		assert.equal(clozePlain("The {{c1::heart}} pumps", false), "The […] pumps");
	});

	it("cleans tags: comma-separated, spaces kept, odd characters replaced, four at most", () => {
		assert.deepEqual(cleanTags("Heat and Temperature, Kardiologie ,Heat and Temperature"), ["Heat and Temperature", "Kardiologie"]);
		assert.deepEqual(cleanTags(["Na+/K+ pump", "a", "b", "c", "d"]), ["Na_K_ pump", "a", "b", "c"]);
		assert.deepEqual(cleanTags("Ca²⁺ (ion)"), ["Ca²_ _ion"]); // superscript digits count as letters, like Python's \w
		assert.deepEqual(cleanTags(undefined), []);
	});

	it("compares words with Unicode letters", () => {
		assert.deepEqual([...tokens("Žlučník je ve")].sort(), ["lučník", "žlučník"].filter((t) => t !== "lučník"));
		assert.equal(norm("Troponin-T (hs)"), "troponinths");
		assert.equal(jaccard(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);
	});

	it("validates boxes and clamps them", () => {
		assert.equal(validBbox([0.1, 0.1, 0.5, 0.5]), true);
		assert.equal(validBbox([0.5, 0.1, 0.1, 0.5]), false);
		assert.equal(validBbox([0.1, 0.1, 1.2, 0.5]), false);
		assert.equal(validBbox(["0.1", "0.1", "0.5", "0.5"]), true);
		assert.equal(validBbox(null), false);
		assert.deepEqual(clampBbox([-0.2, 0.123456, 1.4, "0.5"]), [0, 0.1235, 1, 0.5]);
	});

	it("resolves a figure reference, a box, or nothing", () => {
		const layout = { figures: [{ id: "F1", kind: "raster" as const, bbox: [0.1, 0.2, 0.6, 0.7] as Box }] };
		assert.deepEqual(resolveRegion({ ref: "F1" }, layout), [0.1, 0.2, 0.6, 0.7]);
		assert.deepEqual(resolveRegion({ ref: "F9", bbox: [0.1, 0.1, 0.4, 0.4] }, layout), [0.1, 0.1, 0.4, 0.4]);
		assert.deepEqual(resolveRegion([0.1, 0.1, 0.4, 0.4], layout), [0.1, 0.1, 0.4, 0.4]);
		assert.equal(resolveRegion({ ref: "F9" }, layout), null);
		assert.equal(resolveRegion("F1", layout), null);
	});

	it("keeps only known line ids as the source and unites their boxes with a margin", () => {
		const lines = new Map([
			["L1", { bbox: [0.1, 0.1, 0.5, 0.15] as Box }],
			["L2", { bbox: [0.1, 0.2, 0.4, 0.25] as Box }],
		]);
		const r = resolveSource({ source: ["L1", "L9", "L2"] }, lines);
		assert.deepEqual(r.ids, ["L1", "L2"]);
		assert.deepEqual(r.bbox, [0.094, 0.094, 0.506, 0.256]);
		assert.deepEqual(resolveSource({ source: ["L9"] }, lines), { ids: [], bbox: null });
		assert.deepEqual(resolveSource({}, lines), { ids: [], bbox: null });
	});
});

describe("occlusion expansion", () => {
	const lines = indexLines(
		layoutOf([
			line("L1", "Aorta", [0.2, 0.2, 0.3, 0.23], { tight: [0.2, 0.205, 0.3, 0.225] }),
			line("L2", "Left", [0.2, 0.3, 0.3, 0.33], { tight: [0.2, 0.305, 0.28, 0.325] }),
			line("L3", "ventricle", [0.2, 0.33, 0.3, 0.36], { tight: [0.2, 0.335, 0.3, 0.355] }),
			line("L4", "1.1 Intervertebral surface", [0.7, 0.2, 0.9, 0.22]),
			line("L5", "2", [0.72, 0.5, 0.74, 0.52]),
		]),
	);
	const figures = [{ id: "F1", kind: "raster" as const, bbox: [0.1, 0.1, 0.9, 0.7] as Box }];

	it("takes the fitted box of a line, and unites a label on several lines into ONE mask", () => {
		assert.deepEqual(boxesForIds(["L1"], lines), { boxes: [[0.2, 0.205, 0.3, 0.225]], idsUsed: ["L1"] });
		const two = boxesForIds(["L2", "L3", "L99"], lines);
		assert.deepEqual(two.idsUsed, ["L2", "L3"]);
		assert.equal(two.boxes.length, 1);
		assert.deepEqual(two.boxes[0]!.map((v) => Math.round(v * 1e4) / 1e4), [0.1985, 0.3035, 0.3015, 0.3565]);
	});

	it("builds one card per label with its own tier, defaults the label from the covered text, and shares the figure", () => {
		const raw = {
			header: "Heart: name it",
			figure: { ref: "F1" },
			occlusions: [{ label: "Aorta", ids: ["L1"], priority: 1 }, { ids: ["L2", "L3"] }, { label: "x" }],
		};
		const { cards, dropped } = expandOcclusion(raw, baseInit({ tier: 3 }), { figures }, lines, SETTINGS);
		assert.equal(cards.length, 2);
		assert.deepEqual(cards.map((c) => [c.label, c.tier]), [["Aorta", 1], ["Left ventricle", 3]]);
		assert.equal(dropped.length, 1);
		assert.match(dropped[0]!.reason, /without a box/);
		assert.equal(cards[0]!.header, "Heart: name it");
		assert.equal(cards[0]!.mode, "one");
		assert.deepEqual(cards[0]!.figureBbox, cards[1]!.figureBbox);
		assert.deepEqual(cards[0]!.allBoxes, [cards[0]!.boxes[0], cards[1]!.boxes[0]]);
		assert.deepEqual(cards[0]!.sourceIds, ["L1"]);
		assert.equal(cards[0]!.needsCheck, false);
	});

	it("falls back to the default header and honours the job's mode setting", () => {
		const raw = { mode: "all", occlusions: [{ label: "Aorta", ids: ["L1"] }] };
		const auto = expandOcclusion(raw, baseInit(), { figures }, lines, SETTINGS).cards[0]!;
		assert.equal(auto.header, "Name the marked structure");
		assert.equal(auto.mode, "all");
		const forced = expandOcclusion(raw, baseInit(), { figures }, lines, { ...SETTINGS, ioMode: "one", language: "de" }).cards[0]!;
		assert.equal(forced.mode, "one");
		assert.equal(forced.header, "Benenne die markierte Struktur");
	});

	it("refuses a guessed mask that is too large, keeps a small one and flags it", () => {
		const raw = {
			figure: { ref: "F1" },
			occlusions: [
				{ label: "Frontal lobe", bbox: [0.2, 0.2, 0.7, 0.6] },
				{ label: "Tip", bbox: [0.5, 0.5, 0.52, 0.52] },
			],
		};
		const { cards, dropped } = expandOcclusion(raw, baseInit(), { figures }, lines, SETTINGS);
		assert.deepEqual(cards.map((c) => c.label), ["Tip"]);
		assert.equal(cards[0]!.needsCheck, true);
		assert.deepEqual(cards[0]!.warnings, ["Mask from an estimated box — please check the picture"]);
		assert.match(dropped[0]!.reason, /too large/);
		// a mask the learner drew is never judged by size
		const drawn = expandOcclusion({ ...raw, user_drawn: true }, baseInit(), { figures }, lines, SETTINGS);
		assert.equal(drawn.cards.length, 2);
		assert.equal(drawn.cards[0]!.maskExact, true);
	});

	it("drops a marker box that is far too large", () => {
		const raw = { figure: { ref: "F1" }, occlusions: [{ label: "Aorta", ids: ["L1"], marker_bbox: [0.3, 0.3, 0.6, 0.6] }, { label: "Left", ids: ["L2"], marker_bbox: [0.5, 0.5, 0.52, 0.52] }] };
		const { cards } = expandOcclusion(raw, baseInit(), { figures }, lines, SETTINGS);
		assert.equal(cards[0]!.markerBbox, null);
		assert.deepEqual(cards[1]!.markerBbox, [0.5, 0.5, 0.52, 0.52]);
	});

	it("keeps a picture the learner chose exactly, and enlarges an automatic one", () => {
		const exact = expandOcclusion({ figure: { bbox: [0.15, 0.15, 0.85, 0.65] }, figure_exact: true, occlusions: [{ label: "Aorta", ids: ["L1"] }] }, baseInit(), { figures: [] }, lines, SETTINGS).cards[0]!;
		assert.equal(exact.figureExact, true);
		assert.deepEqual(exact.figureBbox.map((v) => Math.round(v * 1e3) / 1e3), [0.15, 0.15, 0.85, 0.65]);
		const auto = expandOcclusion({ figure: { ref: "F1" }, occlusions: [{ label: "Aorta", ids: ["L1"] }] }, baseInit(), { figures }, lines, SETTINGS).cards[0]!;
		assert.equal(auto.figureExact, false);
		assert.deepEqual(auto.figureBbox, [0.085, 0.085, 0.915, 0.715]);
	});

	it("finds the smallest page figure covering the labels when the model names none", () => {
		const two = [
			{ id: "F1", kind: "raster" as const, bbox: [0, 0, 1, 1] as Box },
			{ id: "F2", kind: "raster" as const, bbox: [0.15, 0.15, 0.4, 0.4] as Box },
		];
		const c = expandOcclusion({ occlusions: [{ label: "Aorta", ids: ["L1"] }] }, baseInit(), { figures: two }, lines, SETTINGS).cards[0]!;
		assert.deepEqual(c.figureBbox, padded([0.15, 0.15, 0.4, 0.4], 0.015));
	});

	it("reads leading numbers, with and without a bullet", () => {
		assert.equal(leadingNumber("1.1 Intervertebral surface"), "1.1");
		assert.equal(leadingNumber("• 2. Spinous process"), "2");
		assert.equal(leadingNumber("2"), "2");
		assert.equal(leadingNumber("Aorta 3"), "");
		assert.equal(nearbyNumberLabel(layoutOf([line("L5", "2", [0.72, 0.5, 0.74, 0.52])]), [0.7, 0.49, 0.73, 0.53]), "2");
		assert.equal(nearbyNumberLabel(layoutOf([line("L5", "2", [0.72, 0.5, 0.74, 0.52])]), [0.1, 0.1, 0.2, 0.2]), "");
	});

	it("merges occlusion groups of the same figure into one", () => {
		const a = occlusion("p001-c01", "Aorta", [0.2, 0.2, 0.3, 0.25], { figureBbox: [0.1, 0.1, 0.5, 0.5], allBoxes: [[0.2, 0.2, 0.3, 0.25]] });
		const b = occlusion("p001-c02", "Vena", [0.3, 0.3, 0.4, 0.35], { figureBbox: [0.2, 0.2, 0.6, 0.6], mode: "all", allBoxes: [[0.3, 0.3, 0.4, 0.35]] });
		const far = occlusion("p001-c03", "Femur", [0.8, 0.8, 0.9, 0.85], { figureBbox: [0.7, 0.7, 0.95, 0.95] });
		mergeOcclusionGroups([a, b, far, basic("p001-c04", "q", "a")]);
		assert.deepEqual(a.figureBbox, b.figureBbox);
		assert.deepEqual(a.figureBbox.map((v) => Math.round(v * 1e4) / 1e4), [0.09, 0.09, 0.61, 0.61]);
		assert.equal(a.mode, "all");
		assert.deepEqual(a.allBoxes, [[0.2, 0.2, 0.3, 0.25], [0.3, 0.3, 0.4, 0.35]]);
		assert.deepEqual(far.figureBbox, [0.7, 0.7, 0.95, 0.95]);
	});

	it("builds a whole-figure cloze with the printed numbers kept visible", () => {
		const raw = {
			figure: { ref: "F1" },
			occlusions: [{ label: "Intervertebral surface", ids: ["L4"], marker_bbox: [0.5, 0.5, 0.52, 0.52] }, { label: "Spinous process", ids: ["L5"] }],
		};
		const { cards } = expandWholeImage(raw, baseInit(), { figures, lines: [...lines.values()] }, lines, SETTINGS);
		assert.equal(cards.length, 1);
		const c = cards[0]!;
		assert.equal(c.type, "cloze");
		assert.equal(c.text, "1.1 {{c1::Intervertebral surface}}\n2 {{c2::Spinous process}}");
		assert.equal(c.legendCloze, true);
		assert.deepEqual(Object.keys(c.markerBoxes), ["1"]);
		assert.deepEqual(c.markerNums, { "1": "1.1" });
		assert.equal(c.image?.where, "front");
	});
});

const padded = (b: Box, m: number): Box => [Math.max(0, b[0] - m), Math.max(0, b[1] - m), Math.min(1, b[2] + m), Math.min(1, b[3] + m)];

describe("duplicates", () => {
	it("calls identical question/answer cards duplicates and keeps the better one", () => {
		const a = basic("p001-c01", "What pumps blood?", "The heart", { tier: 2 });
		const b = basic("p002-c01", "What pumps blood?", "The heart", { tier: 1, page: 2 });
		const groups = findGroups([{ cards: [a, b] }]);
		assert.equal(groups.length, 1);
		assert.equal(groups[0]!.keep, "p002-c01"); // the more important tier
		assert.equal(groups[0]!.reason, "identical");
		assert.deepEqual(groups[0]!.cards.map((c) => c.id), ["p002-c01", "p001-c01"]);
	});

	it("finds similar cards at the review threshold, but not unrelated ones", () => {
		const a = basic("p001-c01", "Which artery supplies the right ventricle wall?", "The right coronary artery");
		const b = basic("p001-c02", "Which artery supplies the right ventricle wall?", "Right coronary artery (RCA)");
		const c = basic("p001-c03", "What is the normal heart rate?", "60 to 100 beats per minute");
		const groups = findGroups([{ cards: [a, b, c] }], 0.6);
		assert.deepEqual(groups.map((g) => g.cards.map((x) => x.id)), [["p001-c01", "p001-c02"]]);
		assert.equal(groups[0]!.reason, "similar");
	});

	it("does not call a cloze with another gap in the same sentence a duplicate", () => {
		const gap = (id: string, text: string) => ({ ...baseInit(), id, type: "cloze" as const, text, legendCloze: true as const, markerBoxes: {}, markerNums: {} }) as CardDraft;
		const a = gap("p001-c01", "The {{c1::aorta}} leaves the left ventricle");
		const b = gap("p001-c02", "The aorta leaves the {{c1::left ventricle}}");
		assert.equal(findGroups([{ cards: [a, b] }], 0.5).length, 0);
		const same = gap("p001-c03", "The {{c1::aorta}} leaves the left ventricle");
		assert.equal(findGroups([{ cards: [a, same] }], 0.5).length, 1);
	});

	it("treats two masks on the same page as one only when label and position agree", () => {
		const a = occlusion("p001-c01", "Aorta", [0.2, 0.2, 0.3, 0.25]);
		const same = occlusion("p001-c02", "Aorta", [0.21, 0.2, 0.31, 0.25]);
		const elsewhere = occlusion("p001-c03", "Aorta", [0.7, 0.7, 0.8, 0.75]);
		const other = occlusion("p001-c04", "Vena cava", [0.2, 0.2, 0.3, 0.25]);
		const groups = findGroups([{ cards: [a, same, elsewhere, other] }]);
		assert.equal(groups.length, 1);
		assert.deepEqual(groups[0]!.cards.map((c) => c.id), ["p001-c01", "p001-c02"]);
		assert.equal(groups[0]!.kind, "occlusion");
		assert.equal(groups[0]!.reason, "same mask");
	});

	it("matches masks across pages only through the figure's picture hash", () => {
		const hash = "0".repeat(63) + "1";
		const a = occlusion("p001-c01", "Aorta", [0.2, 0.2, 0.3, 0.25], { page: 1, figHash: hash, figureBbox: [0.1, 0.1, 0.5, 0.5] });
		const b = occlusion("p005-c01", "Aorta", [0.2, 0.2, 0.3, 0.25], { page: 5, figHash: "0".repeat(64), figureBbox: [0.1, 0.1, 0.5, 0.5] });
		assert.equal(hashDistance(hash, "0".repeat(64)), 1);
		assert.equal(findGroups([{ cards: [a] }, { cards: [b] }]).length, 1);
		const noHash = occlusion("p005-c02", "Aorta", [0.2, 0.2, 0.3, 0.25], { page: 5, figureBbox: [0.1, 0.1, 0.5, 0.5] });
		assert.equal(findGroups([{ cards: [a] }, { cards: [noHash] }]).length, 0);
	});

	it("autoMark removes practically identical cards (restorable) but never the learner's own", () => {
		const a = basic("p001-c01", "What pumps blood?", "The heart");
		const b = basic("p001-c02", "What pumps blood?", "The heart");
		const own = basic("p001-c03", "What pumps blood?", "The heart", { manual: true });
		// the learner's own card is the one to keep, the two model cards go
		assert.equal(autoMark([{ cards: [a, b, own] }]), 2);
		assert.deepEqual([a.deleted, b.deleted, own.deleted], [true, true, false]);
		assert.equal(a.note, `${DUPLICATE_NOTE}p001-c03`);
		// two cards of the learner are never removed against each other
		const x = basic("p002-c01", "Where is the aorta?", "Behind the sternum", { manual: true });
		const y = basic("p002-c02", "Where is the aorta?", "Behind the sternum", { edited: true });
		assert.equal(autoMark([{ cards: [x, y] }]), 0);
		assert.deepEqual([x.deleted, y.deleted], [false, false]);
		// below the automatic threshold nothing is removed
		const p = basic("p003-c01", "Which artery supplies the right ventricle wall?", "The right coronary artery");
		const q = basic("p003-c02", "Which artery supplies the right ventricle wall?", "Right coronary artery (RCA)");
		assert.equal(autoMark([{ cards: [p, q] }]), 0);
	});

	it("ranks the learner's own cards first as the one to keep", () => {
		assert.deepEqual(keepRank(basic("p001-c01", "a", "b")).slice(0, 2), [1, 2]);
		assert.deepEqual(keepRank(basic("p001-c01", "a", "b", { manual: true })).slice(0, 1), [0]);
	});
});

describe("normalizePage", () => {
	const lines = [
		line("L1", "Heart failure causes pulmonary congestion because blood backs up into the lungs.", [0.1, 0.1, 0.9, 0.14], { bold: true }),
		line("L2", "Right heart failure causes peripheral oedema through raised capillary pressure.", [0.1, 0.2, 0.9, 0.24]),
		line("L3", "Aorta", [0.2, 0.5, 0.3, 0.53], { tight: [0.2, 0.505, 0.3, 0.525] }),
	];
	const figure = { id: "F1", kind: "raster" as const, bbox: [0.1, 0.4, 0.9, 0.9] as Box };
	const layout = layoutOf(lines, { figures: [figure] });

	it("returns a skipped page without cards", () => {
		const r = normalizePage({ skip: true, skip_reason: "Title page", topic: "Intro", page_type: "titel", cards: [{ type: "basic", front: "q", back: "a" }] }, layout, 3, SETTINGS);
		assert.equal(r.status, "skipped");
		assert.equal(r.skip, true);
		assert.equal(r.skipReason, "Title page");
		assert.deepEqual(r.cards, []);
	});

	it("makes question/answer cards with ids, tiers, tags and the source marked on the page", () => {
		const r = normalizePage(
			{
				page_type: "text",
				topic: "Heart failure",
				cards: [
					{ type: "basic", priority: 1, why_type: "causal", front: "Left heart failure — where does the blood back up?", back: "Into the lungs.", evidence: "blood backs up into the lungs", source: ["L1"], tags: ["Cardiology"] },
					{ type: "basic_reversed", priority: 5, front: "Peripheral oedema — cause in right heart failure?", back: "Raised capillary pressure", evidence: "raised capillary pressure", source: ["L2", "L99"] },
				],
			},
			layout,
			3,
			SETTINGS,
		);
		assert.equal(r.status, "done");
		assert.equal(r.topic, "Heart failure");
		assert.deepEqual(r.cards.map((c) => [c.id, c.type, c.tier]), [["p003-c01", "basic", 1], ["p003-c02", "basic_reversed", 3]]);
		const first = r.cards[0] as FrontBackCard;
		assert.deepEqual(first.sourceIds, ["L1"]);
		assert.deepEqual(first.tags, ["Cardiology"]);
		assert.ok(first.sourceBbox && first.sourceBbox[0] < 0.1);
		assert.deepEqual((r.cards[1] as FrontBackCard).sourceIds, ["L2"]);
		assert.deepEqual(first.warnings, []);
	});

	it("refuses cloze, unknown types and empty sides, each with a reason", () => {
		const r = normalizePage(
			{ cards: [{ type: "cloze", text: "{{c1::x}}" }, { type: "flash", front: "q", back: "a" }, { type: "basic", front: "q", back: "" }, "junk", { type: "basic", front: "ok?", back: "yes", evidence: "x" }] },
			layout,
			1,
			SETTINGS,
		);
		assert.equal(r.cards.length, 1);
		assert.deepEqual(r.dropped.map((d) => d.reason), ["Cloze is switched off — please phrase it as a question/answer card", "Unknown type 'flash'", "Front or back is empty"]);
	});

	it("needs a picture region for a process card; an image question becomes a basic card with the picture in front", () => {
		const r = normalizePage(
			{
				cards: [
					{ type: "process", front: "Explain the process.", back: "1) a\n2) b", image: { ref: "F1" } },
					{ type: "process", front: "Explain.", back: "1) a\n2) b" },
					{ type: "image_question", front: "Which finding?", back: "Pneumothorax", image: { ref: "F1" } },
					{ type: "basic", front: "Name it", back: "Aorta", image: { bbox: [0.2, 0.5, 0.3, 0.6], where: "front" }, evidence: "Aorta" },
					{ type: "basic", front: "Name it again", back: "Aorta", image: { bbox: [0.2, 0.5, 0.3, 0.6] }, evidence: "Aorta" },
				],
			},
			layout,
			1,
			SETTINGS,
		);
		assert.deepEqual(r.cards.map((c) => [c.type, c.image?.where ?? null]), [["process", "front"], ["basic", "front"], ["basic", "front"], ["basic", "extra"]]);
		assert.match(r.dropped[0]!.reason, /process without a valid picture region/);
		assert.deepEqual(r.cards[0]!.image!.bbox, padded(figure.bbox, 0.005));
		// the picture questions need no quote
		assert.deepEqual(r.cards[1]!.warnings, []);
	});

	it("keeps the evidence rules: a missing quote, a quote not on the page, and the exemptions", () => {
		const text = layout.lines.map((l) => l.text).join(" ");
		assert.ok(text.length >= 120);
		const card = (over: Partial<FrontBackCard>) => basic("p001-c01", "q?", "a", over);
		assert.deepEqual(evidenceWarnings(card({}), layout), ["No evidence quote given"]);
		assert.deepEqual(evidenceWarnings(card({ evidence: "blood backs up into the lungs" }), layout), []);
		assert.deepEqual(evidenceWarnings(card({ evidence: "completely unrelated statement about kidneys" }), layout), ["Evidence quote not found in the page text — please check the content"]);
		assert.deepEqual(evidenceWarnings(card({ type: "process" }), layout), []);
		assert.deepEqual(evidenceWarnings(card({}), layoutOf([line("L1", "short", [0, 0, 1, 0.1])])), []); // hardly any text layer
		assert.equal(isEvidenceWarning("No evidence quote given"), true);
		assert.equal(isEvidenceWarning("Question is very long"), false);
	});

	it("warns about long cards, long answers and a process with one line", () => {
		assert.deepEqual(qualityWarnings(basic("p001-c01", "x".repeat(261), "a")), ["Question is very long"]);
		assert.deepEqual(qualityWarnings(basic("p001-c01", "q", "a\nb\nc\nd")), ["Answer is long / an enumeration — split it into several cards?"]);
		assert.deepEqual(qualityWarnings(basic("p001-c01", "Siehe oben: was ist das?", "a")), ["The question may be unclear without the page"]);
		assert.deepEqual(qualityWarnings(basic("p001-c01", "Explain.", "one line", { type: "process" })), ["A process with a single line — name the steps in order?"]);
		assert.deepEqual(qualityWarnings(basic("p001-c01", "What is it?", "short")), []);
	});

	it("builds occlusion cards, numbered after the question cards of the page", () => {
		const r = normalizePage(
			{
				cards: [
					{ type: "basic", front: "Q?", back: "A", evidence: "Aorta" },
					{ type: "image_occlusion", priority: 1, figure: { ref: "F1" }, occlusions: [{ label: "Aorta", ids: ["L3"], priority: 1 }] },
				],
			},
			layout,
			7,
			SETTINGS,
		);
		assert.deepEqual(r.cards.map((c) => [c.id, c.type]), [["p007-c01", "basic"], ["p007-c02", "image_occlusion"]]);
		const occ = r.cards[1] as OcclusionCard;
		assert.equal(occ.label, "Aorta");
		assert.deepEqual(occ.warnings, []); // occlusions need no evidence quote
	});

	it("limits a vocabulary sheet to word pairs and the best words", () => {
		const vocab = { ...SETTINGS, vocab: true };
		const words = Array.from({ length: 12 }, (_, i) => ({ type: "basic_reversed", priority: i === 11 ? 1 : 2, front: `word${i}`, back: `slovo${i}`, extra: "ignored", image: { ref: "F1" }, evidence: `word${i}` }));
		const r = normalizePage({ cards: [...words, { type: "image_occlusion", figure: { ref: "F1" }, occlusions: [{ label: "x", ids: ["L3"] }] }, { type: "basic", front: "q", back: "a" }] }, layout, 2, vocab);
		assert.equal(r.cards.length, 10);
		assert.ok(r.cards.every((c) => c.type === "basic_reversed" && c.image === null && c.extra === ""));
		// the tier-1 word is kept even though it comes last; the kept cards stay in page order and are renumbered
		assert.deepEqual(r.cards.map((c) => (c as FrontBackCard).front), [...Array.from({ length: 9 }, (_, i) => `word${i}`), "word11"]);
		assert.deepEqual(r.cards.map((c) => c.id).slice(0, 2), ["p002-c01", "p002-c02"]);
		assert.equal(r.cards[9]!.id, "p002-c10");
		assert.equal(r.dropped.filter((d) => /only vocabulary cards/.test(d.reason)).length, 2);
		assert.equal(r.dropped.filter((d) => /limit/.test(d.reason)).length, 2);
	});

	it("removes an identical card of the same page as a duplicate (restorable)", () => {
		const r = normalizePage(
			{ cards: [{ type: "basic", front: "What pumps blood?", back: "The heart", evidence: "heart" }, { type: "basic", front: "What pumps blood?", back: "The heart", evidence: "heart" }] },
			layout,
			1,
			SETTINGS,
		);
		assert.deepEqual(r.cards.map((c) => c.deleted), [false, true]);
		assert.equal(r.cards[1]!.note, "Duplicate of p001-c01");
	});

	describe("legend fallback", () => {
		const legendLines = [
			line("L1", "Heart failure causes pulmonary congestion because blood backs up into the lungs and the right side.", [0.05, 0.05, 0.95, 0.08]),
			line("G1", "Aorta", [0.7, 0.5, 0.8, 0.53], { src: "legend", marker: "1", legend: "LG1", tight: [0.7, 0.505, 0.8, 0.525] }),
			line("G2", "Vena cava", [0.7, 0.56, 0.8, 0.59], { src: "legend", marker: "2", legend: "LG1", tight: [0.7, 0.565, 0.8, 0.585] }),
		];
		const withLegend = layoutOf(legendLines, {
			figures: [{ id: "F1", kind: "raster", bbox: [0.05, 0.3, 0.95, 0.8], legends: ["LG1"] }],
			legends: [{ id: "LG1", kind: "numbered", figure: "F1", bbox: [0.68, 0.49, 0.82, 0.6], entries: ["G1", "G2"], markersInFigure: 2, confident: true }],
		});

		it("builds the occlusion group itself when the model made a picture question only", () => {
			const r = normalizePage({ cards: [{ type: "basic", front: "Name the structures.", back: "Aorta, vena cava", image: { ref: "F1" }, evidence: "x" }] }, withLegend, 4, SETTINGS);
			const occ = r.cards.filter((c): c is OcclusionCard => c.type === "image_occlusion");
			assert.deepEqual(occ.map((c) => c.label), ["Aorta", "Vena cava"]);
			assert.ok(occ.every((c) => c.autoLegend && c.header === "Name the hidden legend entry (number or colour in the image)"));
			assert.deepEqual(occ.map((c) => c.id), ["p004-c02", "p004-c03"]);
			// the picture question that only repeats the legend names is replaced
			assert.equal(r.cards[0]!.deleted, true);
			assert.equal(r.cards[0]!.note, "Replaced by an occlusion of the legend (restorable)");
		});

		it("leaves a figure alone that the model already covered", () => {
			const r = normalizePage({ cards: [{ type: "image_occlusion", figure: { ref: "F1" }, occlusions: [{ label: "Aorta", ids: ["G1"] }] }] }, withLegend, 4, SETTINGS);
			assert.equal(r.cards.length, 1);
		});

		it("does not touch vocabulary sheets, and in the atlas mode does not delete its own cloze card", () => {
			const vocab = normalizePage({ cards: [{ type: "basic_reversed", front: "heart", back: "srdce", evidence: "x" }] }, withLegend, 4, { ...SETTINGS, vocab: true });
			assert.equal(vocab.cards.length, 1);
			const atlas = normalizePage({ cards: [] }, withLegend, 4, { ...SETTINGS, wholeImageCards: true });
			assert.equal(atlas.cards.length, 1);
			assert.equal(atlas.cards[0]!.type, "cloze");
			assert.equal(atlas.cards[0]!.deleted, false);
			// a legend line holds the name only (the number is its marker), so the gaps carry no number here
			assert.equal((atlas.cards[0] as { text: string }).text, "{{c1::Aorta}}\n{{c2::Vena cava}}");
		});
	});

	it("formats card ids", () => {
		assert.equal(cardId(3, 2), "p003-c02");
		assert.equal(cardId(12, 15), "p012-c15");
	});
});
