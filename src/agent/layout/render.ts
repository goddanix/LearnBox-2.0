/**
 * A PDF page as pixels for the layout checks that look at colour (legend swatches, mask planning,
 * OCR): pdfjs paints into an @napi-rs/canvas on a white ground, and the RGBA bytes come back as a
 * core Raster. Same paint engine as the page images the models see (headless.renderPdfPages).
 */

import type { Raster } from "../../core/contracts/page-layout.ts";

/** What of pdfjs's page proxy the painter needs. */
export interface PaintablePage {
	getViewport(opts: { scale: number; offsetX?: number; offsetY?: number }): { width: number; height: number };
	render(params: { canvasContext: unknown; canvas: unknown; viewport: unknown }): { promise: Promise<void> };
}

/** The page painted at `scale` (1 = one pixel per point) onto white. */
export async function renderPageRaster(page: PaintablePage, scale: number): Promise<Raster> {
	const { createCanvas } = await import("@napi-rs/canvas");
	const viewport = page.getViewport({ scale });
	const width = Math.ceil(viewport.width);
	const height = Math.ceil(viewport.height);
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, width, height);
	await page.render({ canvasContext: ctx, canvas, viewport }).promise;
	const image = ctx.getImageData(0, 0, width, height);
	return { width, height, data: image.data };
}

/** Raster → PNG bytes (for OCR and for the cards' images). */
export async function rasterToPng(raster: Raster): Promise<Uint8Array> {
	const { createCanvas } = await import("@napi-rs/canvas");
	const canvas = createCanvas(raster.width, raster.height);
	const ctx = canvas.getContext("2d");
	const image = ctx.createImageData(raster.width, raster.height);
	image.data.set(raster.data);
	ctx.putImageData(image, 0, 0);
	return canvas.toBuffer("image/png");
}

/** PNG bytes → Raster. */
export async function pngToRaster(png: Uint8Array): Promise<Raster> {
	const { createCanvas, loadImage } = await import("@napi-rs/canvas");
	const img = await loadImage(Buffer.from(png));
	const canvas = createCanvas(img.width, img.height);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(img, 0, 0);
	return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}

/**
 * One part of the page (a normalised box) painted at a resolution that fits `targetPx` on its long side
 * (at least 1 pixel per point, at most 6 — small parts get more pixels, which text recognition likes).
 */
export async function renderPageRegion(page: PaintablePage, box: readonly number[], targetPx = 2200): Promise<Raster> {
	const { createCanvas } = await import("@napi-rs/canvas");
	const full = page.getViewport({ scale: 1 });
	const x0 = box[0]! * full.width;
	const y0 = box[1]! * full.height;
	const w = (box[2]! - box[0]!) * full.width;
	const h = (box[3]! - box[1]!) * full.height;
	const zoom = Math.max(1, Math.min(6, targetPx / Math.max(w, h, 1)));
	const viewport = page.getViewport({ scale: zoom, offsetX: -x0 * zoom, offsetY: -y0 * zoom });
	const width = Math.max(1, Math.ceil(w * zoom));
	const height = Math.max(1, Math.ceil(h * zoom));
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, width, height);
	await page.render({ canvasContext: ctx, canvas, viewport }).promise;
	return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}
