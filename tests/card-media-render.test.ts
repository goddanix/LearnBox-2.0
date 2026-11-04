/** The card pictures (src/agent/create/card-media.ts): masks drawn, files named by content, old pictures of a page replaced, markers refined. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pngToRaster } from "../src/agent/layout/render.ts";
import { drawOcclusionPair, realizeMedia, refineMarkers, saveImage } from "../src/agent/create/card-media.ts";
import { COVER_WARNING, MASK_VERSION } from "../src/core/card-media.ts";
import type { CardPageResult, LegendClozeCard, OcclusionCard } from "../src/core/contracts/create-cards.ts";
import type { Box, Raster } from "../src/core/contracts/page-layout.ts";

const base = { page: 3, tier: 2 as const, whyType: "", extra: "", evidence: "", tags: [] as string[], warnings: [] as string[], deleted: false, include: true, manual: false, sourceIds: [] as string[], sourceBbox: null };

/** White picture with dark "text" bars at the given figure-local boxes. */
function figure(w: number, h: number, bars: Box[]): Raster {
	const data = new Uint8ClampedArray(w * h * 4).fill(255);
	for (const b of bars) {
		for (let y = Math.floor(b[1] * h); y < Math.ceil(b[3] * h); y++) {
			for (let x = Math.floor(b[0] * w); x < Math.ceil(b[2] * w); x++) data.set([20, 20, 20, 255], (y * w + x) * 4);
		}
	}
	return { width: w, height: h, data };
}

const occ = (id: string, box: Box, over: Partial<OcclusionCard> = {}): OcclusionCard => ({
	...base,
	id,
	type: "image_occlusion",
	header: "Name it",
	mode: "one",
	figureBbox: [0, 0, 1, 1],
	figureExact: false,
	maskExact: false,
	label: id,
	hint: "",
	boxes: [box],
	markerBbox: null,
	allBoxes: [box],
	needsCheck: false,
	questionFile: null,
	answerFile: null,
	image: null,
	...over,
});

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-media-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("occlusion pictures", () => {
	const bars: Box[] = [[0.2, 0.2, 0.4, 0.25], [0.6, 0.6, 0.8, 0.65]];
	const [a, b] = [occ("p003-c01", bars[0]!), occ("p003-c02", bars[1]!)];
	for (const c of [a, b]) c.allBoxes = bars;

	it("covers the asked label in the question and outlines it in the answer", async () => {
		const raster = figure(400, 300, bars);
		const { question, answer, coverRatio } = await drawOcclusionPair(raster, a, [a, b]);
		const q = await pngToRaster(question.toBuffer("image/png"));
		const an = await pngToRaster(answer.toBuffer("image/png"));
		const px = (r: Raster, x: number, y: number) => [...r.data.slice((y * r.width + x) * 4, (y * r.width + x) * 4 + 3)];
		// the left end of the first bar is orange in the question (the "?" sits in the middle), still dark text in the answer
		assert.deepEqual(px(q, 86, 63), [255, 159, 28]);
		assert.deepEqual(px(an, 86, 63), [20, 20, 20]);
		// the other label stays visible in the "one" mode
		assert.deepEqual(px(q, 280, 190), [20, 20, 20]);
		// an outline around the first mask in the answer
		assert.notDeepEqual(px(an, 80, 66), [255, 255, 255]);
		assert.ok(coverRatio > 0 && coverRatio < 0.05, String(coverRatio));
	});

	it("greys the other masks in the 'all' mode", async () => {
		const all = occ("p003-c03", bars[0]!, { mode: "all", allBoxes: bars });
		const { question } = await drawOcclusionPair(figure(400, 300, bars), all, [all]);
		const q = await pngToRaster(question.toBuffer("image/png"));
		const at = (x: number, y: number) => [...q.data.slice((y * q.width + x) * 4, (y * q.width + x) * 4 + 3)];
		assert.deepEqual(at(280, 190), [110, 124, 145]);
	});

	it("saves a picture under a content-based name and keeps the smaller format", async () => {
		const flat = figure(300, 200, []);
		const name = await saveImage(flat, dir, "io_x");
		assert.match(name, /^io_x_[0-9a-f]{8}\.(png|jpg)$/);
		assert.equal(await saveImage(flat, dir, "io_x"), name);
		assert.ok(fs.existsSync(path.join(dir, name)));
	});
});

describe("a page's pictures", () => {
	const bars: Box[] = [[0.2, 0.2, 0.4, 0.25], [0.6, 0.6, 0.8, 0.65]];
	const result = (): CardPageResult => {
		const a = occ("p003-c01", bars[0]!, { allBoxes: bars });
		const b = occ("p003-c02", bars[1]!, { allBoxes: bars });
		return { page: 3, pageType: "abbildung", skip: false, skipReason: "", topic: "", status: "done", cards: [a, b], dropped: [] };
	};
	const io = (regions: Box[] = []) => ({
		region: async (box: readonly number[]) => {
			regions.push(box as Box);
			return figure(400, 300, bars);
		},
		mediaDir: dir,
		recognize: async () => [],
	});

	it("renders one question and one answer picture per occlusion card, sharing one figure rendering and hash", async () => {
		const regions: Box[] = [];
		const r = result();
		await realizeMedia(r, io(regions));
		assert.equal(regions.length, 1); // both cards share the figure
		const [a, b] = r.cards as OcclusionCard[];
		for (const c of [a!, b!]) {
			assert.match(c.questionFile!, /^io_p003-c0[12]_q_[0-9a-f]{8}\.(png|jpg)$/);
			assert.match(c.answerFile!, /^io_p003-c0[12]_a_[0-9a-f]{8}\.(png|jpg)$/);
			assert.equal(c.maskV, MASK_VERSION);
			assert.ok(fs.existsSync(path.join(dir, c.questionFile!)));
		}
		assert.match(a!.figHash!, /^[0-9a-f]{64}$/);
		assert.equal(a!.figHash, b!.figHash);
	});

	it("replaces the earlier pictures of the page, and only of that page", async () => {
		fs.writeFileSync(path.join(dir, "io_p003-c09_q_old00001.png"), "x");
		fs.writeFileSync(path.join(dir, "io_p004-c01_q_keep0001.png"), "x");
		await realizeMedia(result(), io());
		assert.ok(!fs.existsSync(path.join(dir, "io_p003-c09_q_old00001.png")));
		assert.ok(fs.existsSync(path.join(dir, "io_p004-c01_q_keep0001.png")));
	});

	it("warns once about masks that cover most of the picture", async () => {
		const r = result();
		const big = occ("p003-c04", [0, 0, 1, 0.9], { allBoxes: [[0, 0, 1, 0.9]], maskExact: true });
		r.cards.push(big);
		await realizeMedia(r, io());
		await realizeMedia(r, io());
		assert.deepEqual(big.warnings, [COVER_WARNING]);
	});

	it("cuts a context picture for a card with an image", async () => {
		const r = result();
		r.cards.push({ ...base, id: "p003-c05", type: "basic", front: "Which finding?", back: "x", extra: "", image: { bbox: [0.1, 0.1, 0.6, 0.6], where: "front", file: null } });
		const regions: Box[] = [];
		await realizeMedia(r, io(regions));
		const card = r.cards[2]!;
		assert.match(card.image!.file!, /^img_p003-c05_[0-9a-f]{8}\.(png|jpg)$/);
		assert.deepEqual(regions[1], [0.1, 0.1, 0.6, 0.6]);
	});
});

describe("marker refinement", () => {
	const cloze = (): LegendClozeCard => ({
		...base,
		id: "p003-c06",
		type: "cloze",
		text: "{{c1::Aorta}}\n{{c2::Vena}}",
		legendCloze: true,
		markerBoxes: { "1": [0.1, 0.1, 0.14, 0.14], "2": [0.5, 0.5, 0.54, 0.54] },
		markerNums: { "1": "1", "2": "2" },
		image: { bbox: [0, 0, 1, 1], where: "front", file: null },
	});
	const hit = (text: string, bbox: Box) => ({ text, conf: 0.9, bbox, words: [] });

	it("moves a marker onto the nearest recognised digit with the same number", () => {
		const c = cloze();
		refineMarkers(c, [hit("1", [0.11, 0.11, 0.13, 0.13]), hit("1", [0.8, 0.8, 0.82, 0.82]), hit("2", [0.9, 0.1, 0.92, 0.12])]);
		assert.deepEqual(c.markerBoxes["1"], [0.1, 0.1, 0.14, 0.14]); // 0.11…0.13 padded by 0.01
		assert.deepEqual(c.markerBoxes["2"], [0.5, 0.5, 0.54, 0.54]); // the only "2" is far away: the estimate stays
	});

	it("keeps every estimate without recognition", () => {
		const c = cloze();
		refineMarkers(c, []);
		assert.deepEqual(c.markerBoxes, cloze().markerBoxes);
	});
});
