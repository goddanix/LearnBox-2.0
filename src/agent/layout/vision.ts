/**
 * Text recognition for labels inside raster figures: a tiny Swift helper around Apple's Vision framework
 * (native/vision-ocr/main.swift). Exact text boxes, so occlusion masks do not rest on guessed coordinates.
 * Where Vision is not available (not macOS, no compiler and no prebuilt helper) everything else keeps
 * working — just without OCR labels.
 *
 * Where the helper comes from, in order: `LH_VISION_OCR` (a path, for tests and overrides), the packaged
 * app's `resources/bin/vision-ocr`, a build cached from the source with `swiftc` (development).
 */

import { execFile, execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Box, PageLine, PageWord } from "../../core/contracts/page-layout.ts";

export interface OcrLine {
	text: string;
	/** Vision's confidence, 0..1. */
	conf: number;
	bbox: Box;
	words: PageWord[];
}

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "native", "vision-ocr", "main.swift");

let resolved: string | null | undefined;

/** Path of the helper binary, building it from source on first use; null when there is none. */
export function visionBinary(): string | null {
	if (resolved !== undefined) return resolved;
	resolved = findBinary();
	return resolved;
}

/** Forget the resolved binary (tests change the environment). */
export function resetVisionBinary(): void {
	resolved = undefined;
}

function findBinary(): string | null {
	const override = process.env.LH_VISION_OCR;
	if (override) return fs.existsSync(override) ? override : null;
	if (process.platform !== "darwin") return null;
	const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
	if (resources) {
		const packaged = path.join(resources, "bin", "vision-ocr");
		if (fs.existsSync(packaged)) return packaged;
	}
	return buildFromSource();
}

/** Development: compile the Swift source once into a cache keyed by the source's hash. */
function buildFromSource(): string | null {
	let source: Buffer;
	try {
		source = fs.readFileSync(SOURCE);
	} catch {
		return null; // packaged without the source and without a prebuilt helper
	}
	const hash = crypto.createHash("sha256").update(source).digest("hex").slice(0, 12);
	const dir = path.join(os.tmpdir(), `lh-vision-ocr-${hash}`);
	const binary = path.join(dir, "vision-ocr");
	if (fs.existsSync(binary)) return binary;
	try {
		fs.mkdirSync(dir, { recursive: true });
		execFileSync("swiftc", ["-O", SOURCE, "-o", binary], { stdio: "ignore", timeout: 180_000 });
		return fs.existsSync(binary) ? binary : null;
	} catch {
		return null;
	}
}

export const visionAvailable = (): boolean => visionBinary() !== null;

const isBox = (v: unknown): v is Box => Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number" && Number.isFinite(n));

function parseOcr(stdout: string): OcrLine[] {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		throw new Error("The text recognition helper printed something unreadable");
	}
	if (!Array.isArray(raw)) throw new Error("The text recognition helper printed something unreadable");
	const out: OcrLine[] = [];
	for (const item of raw as Record<string, unknown>[]) {
		if (typeof item?.text !== "string" || typeof item.conf !== "number" || !isBox(item.bbox)) continue;
		const words: PageWord[] = [];
		for (const w of Array.isArray(item.words) ? (item.words as Record<string, unknown>[]) : []) {
			if (typeof w?.t === "string" && isBox(w.bbox)) words.push({ t: w.t, b: w.bbox });
		}
		out.push({ text: item.text, conf: item.conf, bbox: item.bbox, words });
	}
	return out;
}

/** Recognise the text in a PNG file. Empty when Vision is not available. */
export function recognizeImage(pngPath: string, opts: { minConf?: number; signal?: AbortSignal } = {}): Promise<OcrLine[]> {
	const binary = visionBinary();
	if (!binary) return Promise.resolve([]);
	return new Promise((resolve, reject) => {
		execFile(binary, [pngPath, String(opts.minConf ?? 0.4)], { maxBuffer: 32 * 1024 * 1024, timeout: 120_000, signal: opts.signal }, (err, stdout, stderr) => {
			if (err) return reject(new Error(`Text recognition failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
			try {
				resolve(parseOcr(stdout));
			} catch (e) {
				reject(e);
			}
		});
	});
}

/**
 * OCR lines found in a part of a page → page lines. `region` is the part's box on the page (normalised);
 * the recognised boxes are relative to the part and are mapped back. `startAt` numbers the lines (O1, O2 …).
 */
export function ocrLinesOnPage(found: readonly OcrLine[], region: Box, startAt = 1): PageLine[] {
	const rw = region[2] - region[0];
	const rh = region[3] - region[1];
	const map = (b: Box): Box => [region[0] + b[0] * rw, region[1] + b[1] * rh, region[0] + b[2] * rw, region[1] + b[3] * rh].map((v) => Math.round(v * 1e4) / 1e4) as Box;
	return found.map((o, i): PageLine => ({
		id: `O${startAt + i}`,
		text: o.text,
		bbox: map(o.bbox),
		tight: null,
		size: 0,
		src: "ocr",
		bold: false,
		italic: false,
		underline: false,
		inFigure: true,
		words: o.words.map((w) => ({ t: w.t, b: map(w.b) })),
	}));
}
