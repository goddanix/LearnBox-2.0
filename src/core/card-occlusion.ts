/**
 * Image-occlusion cards from the model's answer (Learnbox 2.0, 2026-11): which
 * line(s) of the page each covered label sits on, which part of the page is the
 * figure, and the safety nets that keep a bad answer from becoming an ugly card —
 * guessed boxes that are too large are refused, the labels of one figure always
 * end in ONE group. Also the atlas mode's whole-figure cloze. Pure; ported from
 * MedAnki's medanki/cards.py (`_expand_occlusion` and friends).
 */

import type { CardBase, CardDraft, CardSettings, DroppedCard, LegendClozeCard, OcclusionCard } from "./contracts/create-cards.ts";
import type { Box, PageLayout, PageLine } from "./contracts/page-layout.ts";
import { bboxArea, bboxOverlapRatio, clampBbox, clampTier, cleanText, padBbox, resolveRegion, union, validBbox } from "./card-util.ts";
import { toLocal } from "./mask-plan.ts";

/** Fields of a card before it gets its id. */
export type CardBaseInit = Omit<CardBase, "id">;
export type LineIndex = ReadonlyMap<string, PageLine>;

/** Header over an occlusion picture when the model gives none — in the cards' language. */
export const FALLBACK_HEADER = { de: "Benenne die markierte Struktur", en: "Name the marked structure" } as const;
export const LEGEND_HEADER = {
	de: "Benenne den verdeckten Legendeneintrag (Nummer bzw. Farbe im Bild)",
	en: "Name the hidden legend entry (number or colour in the image)",
} as const;

/** Guessed (not text-anchored) masks may take at most this much of the figure. */
export const MAX_GUESSED_BOX_FRACTION = 0.15;
/** The printed number inside a figure is tiny: a "marker box" larger than this share of the figure is a mistake. */
export const MAX_MARKER_BOX_FRACTION = 0.04;
/** At most this many cards per occlusion group. */
const MAX_PER_GROUP = 24;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const cardLang = (settings: Pick<CardSettings, "language">): "de" | "en" => (settings.language === "de" ? "de" : "en");

export function indexLines(layout: Pick<PageLayout, "lines">): Map<string, PageLine> {
	return new Map(layout.lines.map((l) => [l.id, l]));
}

/**
 * Mask box(es) for line ids: per line the box fitted to the glyphs (`tight`, which does not reach into the
 * neighbour lines; else the line box). A label on several lines becomes ONE large mask, not several small
 * ones whose edges would cut the text.
 */
export function boxesForIds(ids: unknown, lines: LineIndex): { boxes: Box[]; idsUsed: string[] } {
	let boxes: Box[] = [];
	const idsUsed: string[] = [];
	let allTight = true;
	for (const raw of Array.isArray(ids) ? ids : []) {
		const line = lines.get(String(raw));
		if (!line) continue;
		boxes.push([...(line.tight ?? line.bbox)] as Box);
		allTight = allTight && Boolean(line.tight || line.src === "ocr" || line.src === "legend");
		idsUsed.push(String(raw));
	}
	if (boxes.length > 1) boxes = [padBbox(union(boxes), allTight ? 0.0015 : 0.004)];
	return { boxes, idsUsed };
}

/**
 * The figure itself — named by the model (`figure`), or the smallest page figure that covers the used
 * labels — WITHOUT the masks. The normal occlusion unites it with the masks afterwards (they are painted
 * over anyway); the whole-figure cloze keeps only this tight part, so no uncovered legend text with the
 * answer stays visible in the picture.
 */
export function resolveFigureHint(raw: Record<string, unknown>, layout: Pick<PageLayout, "figures">, prelimUnion: Box): Box | null {
	const hint = resolveRegion(raw.figure, layout);
	if (hint) return hint;
	const candidates = layout.figures.map((f) => f.bbox).filter((b) => bboxOverlapRatio(prelimUnion, b) > 0.6);
	if (candidates.length === 0) return null;
	return candidates.reduce((best, b) => (bboxArea(b) < bboxArea(best) ? b : best));
}

interface ResolvedLabel {
	label: string;
	boxes: Box[];
	idsUsed: string[];
	fromBbox: boolean;
	hint: string;
	markerBbox: Box | null;
	tier: ReturnType<typeof clampTier>;
}

/** Occlusion specs of a raw card → one card per covered label. Refused labels come back in `dropped`. */
export function expandOcclusion(
	raw: Record<string, unknown>,
	base: CardBaseInit,
	layout: Pick<PageLayout, "figures">,
	lines: LineIndex,
	settings: Pick<CardSettings, "ioMode" | "language">,
): { cards: OcclusionCard[]; dropped: DroppedCard[] } {
	const dropped: DroppedCard[] = [];
	let resolved: ResolvedLabel[] = [];
	for (const o of Array.isArray(raw.occlusions) ? raw.occlusions : []) {
		if (!isRecord(o)) continue;
		let label = cleanText(o.label);
		const { boxes, idsUsed } = boxesForIds(o.ids, lines);
		let fromBbox = false;
		if (boxes.length === 0 && validBbox(o.bbox)) {
			boxes.push(clampBbox(o.bbox));
			fromBbox = true;
		}
		if (boxes.length === 0) {
			dropped.push({ reason: "Occlusion without a box that could be resolved", raw: o });
			continue;
		}
		// The answer is optional: without one the text of the covered lines is used.
		if (!label && idsUsed.length > 0) label = cleanText(idsUsed.map((id) => lines.get(id)!.text).join(" "));
		resolved.push({
			label,
			boxes,
			idsUsed,
			fromBbox,
			hint: cleanText(o.hint),
			markerBbox: validBbox(o.marker_bbox) ? clampBbox(o.marker_bbox) : null,
			// Every label has its own tier (not every structure of a figure is equally important); without one the group's tier counts.
			tier: "priority" in o ? clampTier(o.priority) : base.tier,
		});
	}
	if (resolved.length === 0) return { cards: [], dropped: [...dropped, { reason: "No valid occlusion", raw }] };

	const prelim = union(resolved.flatMap((r) => r.boxes));
	const figHint = resolveFigureHint(raw, layout, prelim);
	const figAreaRef = figHint ? bboxArea(figHint) : bboxArea(prelim);

	// Safety net: a GUESSED mask that takes a large part of the figure is almost never one label but a whole
	// region (a colour-coded brain lobe with no text in it) — a rectangle cannot outline that cleanly.
	const kept: ResolvedLabel[] = [];
	for (const r of resolved) {
		if (r.fromBbox && !raw.user_drawn && figAreaRef > 0 && bboxArea(r.boxes[0]!) / figAreaRef > MAX_GUESSED_BOX_FRACTION) {
			dropped.push({
				reason: `Estimated mask for “${r.label}” is too large (> ${Math.round(MAX_GUESSED_BOX_FRACTION * 100)} % of the figure) — probably a whole picture region with no text to anchor on, not one label; not created.`,
				raw: { label: r.label, bbox: r.boxes[0] },
			});
			continue;
		}
		kept.push(r);
	}
	resolved = kept;
	if (resolved.length === 0) return { cards: [], dropped };

	// A marker box should hit one tiny printed digit; a much larger one is a mix-up — better none than a wrong spot.
	for (const r of resolved) {
		if (r.markerBbox && figAreaRef > 0 && bboxArea(r.markerBbox) / figAreaRef > MAX_MARKER_BOX_FRACTION) r.markerBbox = null;
	}

	const allBoxes = resolved.flatMap((r) => r.boxes);
	const figureExact = Boolean(raw.figure_exact && figHint);
	const fig: Box = figureExact ? union([figHint!, ...allBoxes.map((b) => padBbox(b, 0.004))]) : padBbox(union(figHint ? [...allBoxes, figHint] : allBoxes), 0.015);

	let mode = String(raw.mode ?? "").toLowerCase();
	if (settings.ioMode === "one" || settings.ioMode === "all") mode = settings.ioMode;
	else if (mode !== "one" && mode !== "all") mode = "one";
	const header = cleanText(raw.header) || FALLBACK_HEADER[cardLang(settings)];

	const cards = resolved.slice(0, MAX_PER_GROUP).map(
		(r): OcclusionCard => ({
			...base,
			id: "",
			type: "image_occlusion",
			tier: r.tier,
			header,
			mode: mode as "one" | "all",
			figureBbox: [...fig] as Box,
			figureExact,
			maskExact: Boolean(raw.user_drawn),
			label: r.label,
			hint: r.hint,
			boxes: r.boxes,
			markerBbox: r.markerBbox,
			allBoxes: [...allBoxes],
			needsCheck: r.fromBbox,
			questionFile: null,
			answerFile: null,
			tags: [...base.tags],
			sourceIds: r.idsUsed,
			sourceBbox: padBbox(union(r.boxes), 0.004),
			warnings: r.fromBbox ? ["Mask from an estimated box — please check the picture"] : [],
		}),
	);
	return { cards, dropped };
}

// ─── the atlas mode: one cloze card per figure ───────────────────────────────

const LEADING_NUMBER = /^(?:[•\-–*]\s*)?(\d+(?:\.\d+)*)\.?(?:\s|$)/;
/** Normalised page distance: only really adjacent numbers count. */
const NUMBER_SEARCH_MAX_DIST = 0.05;

/**
 * The leading number of a line — "1.1" from a line holding just that, as from a whole outline line
 * ("• 1.1 Intervertebral surface …"); the model often names the readable outline line instead of the tiny
 * number in the picture, bullet included.
 */
export function leadingNumber(text: string | undefined): string {
	return LEADING_NUMBER.exec((text ?? "").trim())?.[1] ?? "";
}

/** The number of a legend spot when the model did not name it by id: the nearest line with a leading number close to the mask. "" when none is near enough — better no number than a wrong one. */
export function nearbyNumberLabel(layout: Pick<PageLayout, "lines">, box: Box): string {
	const cx = (box[0] + box[2]) / 2;
	const cy = (box[1] + box[3]) / 2;
	let best = "";
	let bestDist = NUMBER_SEARCH_MAX_DIST;
	for (const line of layout.lines) {
		const n = leadingNumber(line.text);
		if (!n) continue;
		const d = Math.hypot((line.bbox[0] + line.bbox[2]) / 2 - cx, (line.bbox[1] + line.bbox[3]) / 2 - cy);
		if (d < bestDist) {
			best = n;
			bestDist = d;
		}
	}
	return best;
}

/**
 * The atlas mode's alternative to single occlusions: ONE cloze card with the untouched figure (always
 * visible) and its whole legend underneath — each structure its own gap, the printed number stays visible,
 * only the term is hidden. One note makes several cards (one per gap), so every structure is asked on its
 * own and they all share the picture.
 */
export function expandWholeImage(
	raw: Record<string, unknown>,
	base: CardBaseInit,
	layout: Pick<PageLayout, "figures" | "lines">,
	lines: LineIndex,
	settings: Pick<CardSettings, "ioMode" | "language">,
): { cards: LegendClozeCard[]; dropped: DroppedCard[] } {
	const { cards: expanded, dropped } = expandOcclusion(raw, base, layout, lines, settings);
	if (expanded.length === 0) return { cards: [], dropped };
	// ONLY the figure, not the expanded figure box (which holds the masks): here that would often pull the
	// uncovered outline / legend column with the answers into the picture.
	const prelim = union(expanded.flatMap((c) => c.boxes));
	const figHint = resolveFigureHint(raw, layout, prelim);
	const fig: Box = figHint ? padBbox(figHint, 0.015) : expanded[0]!.figureBbox;

	const gaps: string[] = [];
	const markerBoxes: Record<string, Box> = {};
	const markerNums: Record<string, string> = {};
	let anyEstimated = false;
	expanded.forEach((c, k) => {
		const i = k + 1;
		if (!c.label) return;
		let n = "";
		for (const id of c.sourceIds) {
			n = leadingNumber(lines.get(id)?.text);
			if (n) break;
		}
		// No usable leading number through the referenced lines (e.g. the model marked the digit in the picture
		// with an estimated box): look for a numbered line near the box.
		if (!n && c.boxes.length > 0) n = nearbyNumberLabel(layout, c.boxes[0]!);
		if (c.needsCheck) anyEstimated = true;
		if (c.markerBbox) {
			// Figure-local to the picture SHOWN here (`fig`), not to the occlusion's figure box — they can differ.
			markerBoxes[String(i)] = toLocal(c.markerBbox, fig);
			markerNums[String(i)] = n;
		}
		gaps.push(`${n ? `${n} ` : ""}{{c${i}::${c.label}}}`);
	});
	if (gaps.length === 0) return { cards: [], dropped: [...dropped, { reason: "No named structures for a whole-figure card", raw }] };

	const card: LegendClozeCard = {
		...base,
		id: "",
		type: "cloze",
		text: gaps.join("\n"),
		image: { bbox: [...fig] as Box, where: "front", file: null },
		tags: [...base.tags],
		legendCloze: true,
		markerBoxes,
		markerNums,
		warnings: anyEstimated ? ["Some terms are anchored on estimated boxes — please check the picture and the numbering"] : [],
	};
	return { cards: [card], dropped };
}

/**
 * Safety net: occlusion cards of the same figure (overlapping figure boxes) that the model delivered as
 * several groups are made ONE group — one picture, a shared mask list for the "all" mode. Works whether or
 * not the model followed "one group per figure".
 */
export function mergeOcclusionGroups(cards: readonly CardDraft[], overlapThreshold = 0.2): void {
	const occ = cards.filter((c): c is OcclusionCard => c.type === "image_occlusion" && !c.deleted);
	if (occ.length < 2) return;
	const groups: OcclusionCard[][] = occ.map((c) => [c]);
	const unionOf = (g: OcclusionCard[]) => union(g.map((c) => c.figureBbox));
	let changed = true;
	while (changed) {
		changed = false;
		for (let i = 0; i < groups.length && !changed; i++) {
			const bi = unionOf(groups[i]!);
			for (let j = i + 1; j < groups.length; j++) {
				if (bboxOverlapRatio(bi, unionOf(groups[j]!)) > overlapThreshold) {
					groups[i]!.push(...groups[j]!);
					groups.splice(j, 1);
					changed = true;
					break;
				}
			}
		}
	}
	for (const g of groups) {
		if (g.length <= 1) continue;
		const sharedFig = padBbox(unionOf(g), 0.01);
		const sharedAll = g.flatMap((c) => c.boxes);
		const sharedMode = g.some((c) => c.mode === "all") ? "all" : g[0]!.mode;
		for (const c of g) {
			c.figureBbox = [...sharedFig] as Box;
			c.allBoxes = [...sharedAll];
			c.mode = sharedMode;
		}
	}
}
