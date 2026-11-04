/**
 * Page layout contracts (Learnbox 2.0, 2026-11): what the Create pipeline knows
 * about one PDF page BEFORE a model sees it — text lines with ids and boxes,
 * emphasis (bold / italic / underline), figure regions. Ported from MedAnki's
 * PyMuPDF layer (medanki/pdfio.py); the extraction itself lives in
 * src/agent/layout (pdfjs), the rules in src/core/page-layout.ts.
 *
 * Every box is [x0, y0, x1, y1], normalised to 0..1 against the page, origin top
 * left — so it matches the page image the model sees 1:1.
 */

export type Box = [number, number, number, number];

/** Where a line came from: the PDF's text layer, OCR on a raster figure, or a legend entry's name. */
export type PageLineSource = "pdf" | "ocr" | "legend";

/** One word with its box. */
export interface PageWord {
	t: string;
	b: Box;
}

export interface PageLine {
	/** "L1", "L2", … — the handle a prompt refers to a line by; "O1…" for OCR lines, "G1…" for legend entries. */
	id: string;
	text: string;
	bbox: Box;
	/** Box fitted to the glyphs (no line-gap overhang); null for rotated text. */
	tight: Box | null;
	/** Largest font size on the line, in points (one decimal). */
	size: number;
	src: PageLineSource;
	bold: boolean;
	italic: boolean;
	underline: boolean;
	inFigure: boolean;
	/** The line's words (PDF text and OCR with word boxes); legends tell a number from its name by them. */
	words?: PageWord[];
	/** Legend entries only (src "legend"): the marker ("1", "A", "■"), the legend, and the line it was read from. */
	marker?: string;
	legend?: string;
	line?: string;
}

export type PageFigureKind = "raster" | "vector";

export interface PageFigure {
	/** "F1", "F2", … top to bottom. */
	id: string;
	kind: PageFigureKind;
	bbox: Box;
	/** Legends that explain this figure (the box then covers figure AND legend). */
	legends?: string[];
}

export type LegendKind = "numbered" | "lettered" | "swatch";

/** A list at the figure's edge that names its parts: numbers / letters in the figure, or colour swatches. */
export interface PageLegend {
	id: string;
	kind: LegendKind;
	figure: string;
	bbox: Box;
	/** Ids of the legend-entry lines ("G1", …). */
	entries: string[];
	/** How many of the legend's markers also stand in the figure as text of their own. */
	markersInFigure: number;
	/** Sure enough to build an occlusion group without the model's say-so. */
	confident: boolean;
}

export interface PageLayout {
	widthPt: number;
	heightPt: number;
	lines: PageLine[];
	figures: PageFigure[];
	legends: PageLegend[];
	/** Characters of line text on the page. */
	chars: number;
	/** The most title-like line (large, near the top), cut to 90 characters. */
	title: string;
}

// ─── raw page: what the PDF reader hands to the rules ─────────────────────────
// Points, origin top left (the viewport's frame), so the rules never see PDF
// space or page rotation.

export type Rect = [number, number, number, number];

/** One run of shown text. */
export interface RawTextItem {
	str: string;
	/** Start of the baseline. */
	x: number;
	/** End of the run along the baseline. */
	x1: number;
	baseline: number;
	/** Font size in points. */
	size: number;
	/** Font ascent / descent as fractions of the size (descent is negative or zero); 0 when the font does not say. */
	ascent: number;
	descent: number;
	/** The font's own name, e.g. "ABCDEF+Calibri-Bold". */
	font: string;
	/** Axis-aligned, left to right; rotated or vertical runs are lines of their own without a tight box. */
	horizontal: boolean;
	/** Bounding box in points (set for every item; the only geometry of a rotated run). */
	rect: Rect;
}

export interface RawPage {
	widthPt: number;
	heightPt: number;
	items: RawTextItem[];
	/** Placed raster images (stencil masks included). */
	images: Rect[];
	/** Bounding box of every painted vector path. */
	drawings: Rect[];
	/** Thin, wide painted shapes (rules, underline bars): horizontal line segments and slim rectangles. */
	rules: Rect[];
}

/** A rendered page (or a part of one): RGBA bytes, row by row. */
export interface Raster {
	width: number;
	height: number;
	data: Uint8ClampedArray | Uint8Array;
}
