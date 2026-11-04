/**
 * Editing draft cards and making cards by hand (Learnbox 2.0, 2026-11, the focus screen). Pure; ported from
 * MedAnki's `patch_card` (app.py), `build_manual_card` / `_build_manual_occlusion` (cards.py) and the geometry of
 * `edit_occlusion_mask` / `edit_image_bbox` (pipeline.py). Re-drawing the pictures afterwards is the runner's job.
 */

import { COVER_WARNING } from "./card-media.ts";
import { type CardBaseInit, cardLang, expandOcclusion, FALLBACK_HEADER, indexLines } from "./card-occlusion.ts";
import { cardId, normalizeTextCard, qualityWarnings } from "./card-normalize.ts";
import { clampBbox, clampTier, cleanTags, cleanText, clozeOk, padBbox, union, validBbox } from "./card-util.ts";
import type { CardDraft, CardSettings, CardTier, OcclusionCard } from "./contracts/create-cards.ts";
import type { Box, PageLayout } from "./contracts/page-layout.ts";

/** An edit the learner's input cannot be applied for (shown as it is, 400). */
export class CardEditError extends Error {}

const EDITABLE_TEXT = ["text", "front", "back", "extra", "header", "label"] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The number after "-c" of a card id. */
export const cardNumber = (id: string): number => Number(/-c(\d+)$/.exec(id)?.[1] ?? 0);

/** The next free index on a page (the cards keep their numbers, also after deletions). */
export const nextCardIndex = (cards: readonly { id: string }[]): number => Math.max(0, ...cards.map((c) => cardNumber(c.id))) + 1;

// ─── editing ─────────────────────────────────────────────────────────────────

/**
 * Applies the learner's changes to one card: the texts, the tags, the importance (tier), whether it is selected,
 * and throwing it away / bringing it back. Everything is checked first, so a refused edit changes nothing.
 * Changing a text marks the card edited and checks its quality again (the Mask warnings and the machine's evidence
 * check are not repeated for a card the learner has rewritten).
 */
export function applyCardEdit(c: CardDraft, body: Record<string, unknown>): void {
	const texts: Partial<Record<(typeof EDITABLE_TEXT)[number], string>> = {};
	for (const key of EDITABLE_TEXT) {
		if (!(key in body) || !(key in c || key === "extra")) continue;
		const value = cleanText(body[key]);
		if (key === "text") {
			const { ok, why } = clozeOk(value);
			if (!ok) throw new CardEditError(`The gap text is invalid: ${why}`);
		}
		if ((key === "front" || key === "back" || key === "text") && !value) throw new CardEditError("This field must not be empty.");
		texts[key] = value; // the answer of an occlusion stays optional: the answer picture shows it
	}
	let tier: CardTier | undefined;
	if ("tier" in body) {
		const v = body.tier;
		const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
		if (!Number.isInteger(n)) throw new CardEditError("Invalid importance.");
		tier = clampTier(n);
	}

	let edited = false;
	Object.assign(c, texts);
	if (Object.keys(texts).length > 0) edited = true;
	if (tier !== undefined) {
		c.tier = tier;
		edited = true;
	}
	if ("tags" in body) c.tags = cleanTags(body.tags);
	if ("include" in body) c.include = Boolean(body.include);
	if ("deleted" in body) {
		c.deleted = Boolean(body.deleted);
		if (c.deleted) c.note = "Deleted by hand";
		else {
			c.restored = true; // brought back by the learner: never thrown away by the machine again
			delete c.note;
		}
	}
	if (edited) {
		c.warnings = [...c.warnings.filter((w) => w.startsWith("Mask")), ...qualityWarnings(c)];
		c.edited = true;
	}
}

// ─── cards by hand ───────────────────────────────────────────────────────────

const MANUAL_TYPES = new Set(["basic", "basic_reversed", "image_occlusion"]);

/**
 * A card the learner made on the focus screen: question/answer (also both ways), or an image occlusion over an area
 * they drew on the page (`bbox`, page-normalised) — the figure around it is found as for the model's cards unless
 * they chose one (`figure`). Returns the card, or null with the reason.
 */
export function buildManualCard(
	payload: Record<string, unknown>,
	layout: PageLayout,
	page: number,
	index: number,
	settings: Pick<CardSettings, "ioMode" | "language">,
): { card: CardDraft | null; reason: string } {
	const ctype = String(payload.type ?? "").trim();
	if (!MANUAL_TYPES.has(ctype)) return { card: null, reason: "Unknown or unsupported card type" };
	const base: CardBaseInit = {
		page,
		tier: clampTier(payload.tier ?? 2),
		whyType: "Added by hand",
		extra: cleanText(payload.extra),
		evidence: "",
		tags: cleanTags(payload.tags),
		warnings: [],
		deleted: false,
		include: true,
		manual: true,
		sourceIds: [],
		sourceBbox: null,
		image: null,
	};

	if (ctype === "image_occlusion") {
		if (!validBbox(payload.bbox)) return { card: null, reason: "Please select the area to cover on the page first." };
		const raw: Record<string, unknown> = {
			type: "image_occlusion",
			header: cleanText(payload.header) || FALLBACK_HEADER[cardLang(settings)],
			mode: "one",
			user_drawn: true, // exactly as drawn: no "estimated box is too large" check
			occlusions: [{ label: cleanText(payload.label), ids: [], bbox: clampBbox(payload.bbox) }],
		};
		const fig = isRecord(payload.figure) ? payload.figure.bbox : payload.figure;
		if (validBbox(fig)) {
			raw.figure = { bbox: clampBbox(fig) };
			raw.figure_exact = true;
		}
		const { cards, dropped } = expandOcclusion(raw, base, layout, indexLines(layout), settings);
		const card = cards[0];
		if (!card) return { card: null, reason: dropped[0]?.reason ?? "The occlusion could not be created." };
		card.id = cardId(page, index);
		card.needsCheck = false; // the box is the learner's own, not a guess
		card.warnings = [];
		return { card, reason: "" };
	}

	const { card, reason } = normalizeTextCard({ front: payload.front, back: payload.back }, base, ctype, layout);
	if (!card) return { card: null, reason };
	card.id = cardId(page, index);
	card.warnings = qualityWarnings(card);
	return { card, reason: "" };
}

// ─── moving a mask / the shown part of a picture ─────────────────────────────

const sameBox = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Moves or scales the mask of one occlusion card (`bbox`) and/or changes the part of the page its picture shows
 * (`figure`, the same for the whole group of cards on that figure; it may shrink, but never so far that a mask
 * of the group falls out). Without `figure` the shown part may only grow (a mask pushed out of it). Changes the
 * cards in place and returns the card and its group — they all need their pictures drawn again — or null when the
 * request is not valid for this card.
 */
export function applyMaskEdit(
	pageCards: readonly CardDraft[],
	id: string,
	edit: { bbox?: unknown; figure?: unknown },
): { target: OcclusionCard; group: OcclusionCard[] } | null {
	if (edit.bbox == null && edit.figure == null) return null;
	if (edit.bbox != null && !validBbox(edit.bbox)) return null;
	if (edit.figure != null && !validBbox(edit.figure)) return null;
	const target = pageCards.find((c) => c.id === id);
	if (!target || target.type !== "image_occlusion") return null;

	const oldFig = target.figureBbox;
	const group = pageCards.filter((c): c is OcclusionCard => c.type === "image_occlusion" && sameBox(c.figureBbox, oldFig));

	if (edit.bbox != null) {
		const box = clampBbox(edit.bbox as number[]);
		target.boxes = [box];
		target.sourceBbox = padBbox(box, 0.004);
		target.sourceIds = []; // positioned by hand: no line behind it any more
		target.needsCheck = false;
		target.warnings = target.warnings.filter((w) => !w.startsWith("Mask"));
		target.maskExact = true; // render exactly as placed
	}
	target.edited = true;

	const allBoxes = group.map((c) => c.boxes[0]!);
	const padded = allBoxes.map((b) => padBbox(b, 0.004));
	let fig: Box;
	let exact: boolean;
	if (edit.figure != null) {
		fig = union([clampBbox(edit.figure as number[]), ...padded]);
		exact = true;
	} else if (target.figureExact) {
		fig = union([oldFig, ...padded]); // an already chosen part: only grows, no extra margin
		exact = true;
	} else {
		fig = union([oldFig, padBbox(union(allBoxes), 0.015)]); // the automatic part must not shrink: the figure often reaches beyond the labels
		exact = false;
	}
	for (const c of group) {
		c.figureBbox = [...fig] as Box;
		c.allBoxes = [...allBoxes];
		if (exact) c.figureExact = true;
		c.warnings = c.warnings.filter((w) => w !== COVER_WARNING); // made anew when the picture is drawn
	}
	return { target, group };
}

/** Changes the shown part of a card's context picture (a gap text over a figure, a picture question). The old file name comes back to be removed. */
export function applyImageEdit(pageCards: readonly CardDraft[], id: string, bbox: unknown): { card: CardDraft; oldFile: string | null } | null {
	if (!validBbox(bbox)) return null;
	const card = pageCards.find((c) => c.id === id);
	if (!card || !card.image) return null;
	const oldFile = card.image.file;
	card.image.bbox = clampBbox(bbox);
	card.edited = true;
	return { card, oldFile };
}
