/**
 * The pictures of a page's cards (Learnbox 2.0, 2026-11): the PDF page as the model sees it, parts of
 * it cut out for context pictures, and the question / answer pictures of image-occlusion cards with
 * their masks drawn. Ported from MedAnki's occlusion.py (drawing, saving) and pipeline.realize_media;
 * where a mask goes is core/mask-plan.ts, which card is the question core/card-media.ts.
 * Pictures are finished files (not Anki's own occlusion note type), so they work in every viewer.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { COVER_WARNING, MASK_VERSION, MAX_COVER_RATIO, maskInputs } from "../../core/card-media.ts";
import { padBbox } from "../../core/card-util.ts";
import type { CardDraft, CardPageResult, LegendClozeCard } from "../../core/contracts/create-cards.ts";
import type { Box, Raster } from "../../core/contracts/page-layout.ts";
import { dhash } from "../../core/image-hash.ts";
import { planMasks } from "../../core/mask-plan.ts";
import { type PaintablePage, rasterToPng, renderPageRaster, renderPageRegion } from "../layout/render.ts";
import type { OcrLine } from "../layout/vision.ts";
import { providerSafePng } from "../subagents/headless.ts";
import { standardFontsDir } from "../subagents/pdf-ops.ts";

/** The page image the model reads: this many pixels on its long side (MedAnki's setting). */
export const PAGE_IMAGE_LONG_SIDE = 1800;
/** Context pictures and the figure of an occlusion. */
const FIGURE_PX = 1600;
const IMAGE_PX = 1400;
/** Marker search: the printed number is looked for this close to the model's estimate. */
const MARKER_SEARCH_MAX_DIST = 0.05;

// ─── the PDF, opened once per page job ───────────────────────────────────────

export interface PdfSession {
	numPages: number;
	/** The whole page as PNG, `longSide` pixels on its long side. */
	renderPage(page: number, longSide: number): Promise<Uint8Array>;
	/** A part of the page (normalised box) painted to fit `targetPx` on its long side. */
	renderRegion(page: number, box: readonly number[], targetPx: number): Promise<Raster>;
	close(): Promise<void>;
}

export async function openPdfSession(file: string): Promise<PdfSession> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const data = new Uint8Array(await fs.readFile(file));
	const task = pdfjs.getDocument({ data, standardFontDataUrl: standardFontsDir(), verbosity: 0 });
	const doc = await task.promise;
	const pageOf = async (n: number) => {
		if (n < 1 || n > doc.numPages) throw new Error(`page ${n} is not in the PDF`);
		return (await doc.getPage(n)) as unknown as PaintablePage;
	};
	return {
		numPages: doc.numPages,
		async renderPage(n, longSide) {
			const page = await pageOf(n);
			const full = page.getViewport({ scale: 1 });
			const raster = await renderPageRaster(page, longSide / Math.max(full.width, full.height));
			return providerSafePng(Buffer.from(await rasterToPng(raster)));
		},
		async renderRegion(n, box, targetPx) {
			return renderPageRegion(await pageOf(n), box, targetPx);
		},
		close: () => task.destroy(),
	};
}

// ─── drawing ─────────────────────────────────────────────────────────────────

const MASK_ACTIVE = "rgb(255,159,28)";
const MASK_INACTIVE = "rgb(110,124,145)";
const MASK_BORDER = "rgb(35,35,35)";
const ANSWER_OUTLINE = "rgb(34,160,90)";

type Canvas = import("@napi-rs/canvas").Canvas;
type Ctx = import("@napi-rs/canvas").SKRSContext2D;

async function canvasOf(raster: Raster): Promise<Canvas> {
	const { createCanvas } = await import("@napi-rs/canvas");
	const canvas = createCanvas(raster.width, raster.height);
	const image = canvas.getContext("2d").createImageData(raster.width, raster.height);
	image.data.set(raster.data);
	canvas.getContext("2d").putImageData(image, 0, 0);
	return canvas;
}

function roundedRect(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, radius: number): void {
	const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
	ctx.beginPath();
	ctx.moveTo(x0 + r, y0);
	ctx.arcTo(x1, y0, x1, y1, r);
	ctx.arcTo(x1, y1, x0, y1, r);
	ctx.arcTo(x0, y1, x0, y0, r);
	ctx.arcTo(x0, y0, x1, y0, r);
	ctx.closePath();
}

function drawMask(ctx: Ctx, rect: readonly number[], color: string, questionMark: boolean): void {
	const [x0, y0, x1, y1] = rect as [number, number, number, number];
	roundedRect(ctx, x0, y0, x1, y1, 4);
	ctx.fillStyle = color;
	ctx.fill();
	ctx.lineWidth = 2;
	ctx.strokeStyle = MASK_BORDER;
	ctx.stroke();
	const h = y1 - y0;
	if (questionMark && h >= 14) {
		ctx.fillStyle = "rgb(40,40,40)";
		ctx.font = `${Math.round(Math.min(h * 0.7, 64))}px sans-serif`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText("?", (x0 + x1) / 2, (y0 + y1) / 2);
	}
}

export interface OcclusionPair {
	question: Canvas;
	answer: Canvas;
	/** Share of the picture the question's masks cover. */
	coverRatio: number;
}

/** The question picture (this card's masks in orange; in the "all" mode the others grey) and the answer picture (its masks outlined in green). */
export async function drawOcclusionPair(base: Raster, card: Parameters<typeof maskInputs>[0], pageCards: readonly CardDraft[]): Promise<OcclusionPair> {
	const inputs = maskInputs(card, pageCards);
	const { targets, others } = planMasks(base, inputs.targets, inputs.others, inputs.targetModes, inputs.otherModes);
	const question = await canvasOf(base);
	const answer = await canvasOf(base);
	const dq = question.getContext("2d");
	const da = answer.getContext("2d");
	if (card.mode === "all") {
		for (const r of others) {
			drawMask(dq, r, MASK_INACTIVE, false);
			drawMask(da, r, MASK_INACTIVE, false);
		}
	}
	let covered = 0;
	const w = Math.max(3, Math.floor(0.003 * Math.max(base.width, base.height)));
	for (const r of targets) {
		drawMask(dq, r, MASK_ACTIVE, true);
		covered += (r[2] - r[0]) * (r[3] - r[1]);
		roundedRect(da, r[0] - w, r[1] - w, r[2] + w, r[3] + w, 6);
		da.lineWidth = w;
		da.strokeStyle = ANSWER_OUTLINE;
		da.stroke();
	}
	return { question, answer, coverRatio: covered / (base.width * base.height) };
}

/** Saves a picture as PNG or JPEG (whichever is clearly smaller) under a content-based name; returns the file name. */
export async function saveImage(canvas: Canvas | Raster, dir: string, stem: string): Promise<string> {
	const c = "toBuffer" in canvas ? canvas : await canvasOf(canvas);
	const png = c.toBuffer("image/png");
	const jpg = c.toBuffer("image/jpeg", 88);
	const [data, ext] = jpg.length < 0.8 * png.length ? [jpg, "jpg"] : [png, "png"];
	const name = `${stem}_${crypto.createHash("sha1").update(data).digest("hex").slice(0, 8)}.${ext}`;
	await fs.writeFile(path.join(dir, name), data);
	return name;
}

// ─── the printed number inside a figure ──────────────────────────────────────

const roundBox = (b: readonly number[]): Box => b.map((v) => Math.round(v * 1e4) / 1e4) as Box;

/**
 * The model's marker box is only a vision estimate of a tiny printed digit. Text recognition on the
 * figure finds where the digit really stands: the nearest hit with the SAME number replaces the
 * estimate. Without recognition, or without a clear hit nearby, the estimate stays — better rough
 * than on the wrong digit.
 */
export function refineMarkers(card: LegendClozeCard, found: readonly OcrLine[]): void {
	for (const [key, box] of Object.entries(card.markerBoxes)) {
		const expected = (card.markerNums[key] ?? "").trim();
		if (!expected) continue;
		const cx = (box[0] + box[2]) / 2;
		const cy = (box[1] + box[3]) / 2;
		let best: Box | null = null;
		let bestDist = MARKER_SEARCH_MAX_DIST;
		for (const r of found) {
			if (r.text.replace(/\D/g, "") !== expected) continue;
			const d = Math.hypot((r.bbox[0] + r.bbox[2]) / 2 - cx, (r.bbox[1] + r.bbox[3]) / 2 - cy);
			if (d < bestDist) {
				best = r.bbox;
				bestDist = d;
			}
		}
		if (best) card.markerBoxes[key] = padBbox(roundBox(best), 0.01);
	}
}

// ─── a page's pictures ───────────────────────────────────────────────────────

export interface PageMediaIo {
	/** The part of the page behind `box`, painted to fit `targetPx`. */
	region: (box: readonly number[], targetPx: number) => Promise<Raster>;
	/** The card pictures' folder. */
	mediaDir: string;
	/** Text recognition on a PNG file; empty without it. */
	recognize: (pngPath: string) => Promise<OcrLine[]>;
}

/** Renders (again) every picture of the page's cards and records the file names on the cards. Old pictures of the page go. */
export async function realizeMedia(result: CardPageResult, io: PageMediaIo): Promise<void> {
	const tag = `_p${String(result.page).padStart(3, "0")}-`;
	for (const name of await fs.readdir(io.mediaDir).catch(() => [] as string[])) {
		if (name.includes(tag)) await fs.rm(path.join(io.mediaDir, name), { force: true });
	}

	const figures = new Map<string, { raster: Raster; hash: string }>();
	for (const c of result.cards) {
		if (c.type === "image_occlusion") {
			const key = c.figureBbox.join(",");
			let fig = figures.get(key);
			if (!fig) {
				const raster = await io.region(c.figureBbox, FIGURE_PX);
				fig = { raster, hash: dhash(raster) };
				figures.set(key, fig);
			}
			c.figHash = fig.hash;
			const { question, answer, coverRatio } = await drawOcclusionPair(fig.raster, c, result.cards);
			c.warnings = c.warnings.filter((w) => w !== COVER_WARNING); // made anew at every rendering
			if (coverRatio > MAX_COVER_RATIO) c.warnings.push(COVER_WARNING);
			c.questionFile = await saveImage(question, io.mediaDir, `io_${c.id}_q`);
			c.answerFile = await saveImage(answer, io.mediaDir, `io_${c.id}_a`);
			c.maskV = MASK_VERSION;
		} else if (c.image) {
			await realizeImage(c, io);
		}
	}
}

/** The context picture of ONE card (a picture question, a process, a whole-figure cloze). */
export async function realizeImage(card: CardDraft, io: PageMediaIo): Promise<void> {
	if (!card.image) return;
	if (card.type === "cloze" && !card.edited && Object.keys(card.markerBoxes).length > 0) {
		const hiRes = await io.region(card.image.bbox, 2200);
		const tmp = path.join(io.mediaDir, `.ocr_marker_${card.id}.png`);
		try {
			await fs.writeFile(tmp, await rasterToPng(hiRes));
			refineMarkers(card, await io.recognize(tmp));
		} catch {
			// recognition is a refinement; the model's estimate stays
		} finally {
			await fs.rm(tmp, { force: true });
		}
	}
	card.image.file = await saveImage(await io.region(card.image.bbox, IMAGE_PX), io.mediaDir, `img_${card.id}`);
}
