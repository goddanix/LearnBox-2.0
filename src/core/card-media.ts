/**
 * What the card pictures need to know about their cards (Learnbox 2.0, 2026-11) — the pure part of
 * MedAnki's media step (pipeline._mask_inputs): which masks of an occlusion group are the question and
 * which only context, and how each mask is to be drawn. Drawing itself is agent/create/card-media.ts.
 */

import type { CardDraft, OcclusionCard } from "./contracts/create-cards.ts";
import type { Box } from "./contracts/page-layout.ts";
import type { MaskMode } from "./mask-plan.ts";
import { toLocal } from "./mask-plan.ts";

/** Version of the mask planning a rendering was made with (cards keep the version of their last rendering). */
export const MASK_VERSION = 2;
/** A mask group covering more than this share of the picture is flagged. */
export const MAX_COVER_RATIO = 0.35;
export const COVER_WARNING = "Mask covers a very large area — please check the box";

/** Drawn by hand / moved by hand? Such a mask is rendered exactly as drawn. (The learner's own cards, and cards whose lines were dropped by editing, count too.) */
export const isMaskExact = (c: OcclusionCard): boolean => Boolean(c.maskExact || c.manual || (c.edited && c.sourceIds.length === 0));

/** "text" (hugs the glyphs), "exact" (as drawn) or "box" (an estimated box around a non-text target: keep its margin). */
export const maskModeOf = (c: OcclusionCard): MaskMode => (isMaskExact(c) ? "exact" : c.needsCheck ? "box" : "text");

const sameBox = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export interface MaskInputs {
	/** The masks of THIS card (the question), figure-local. */
	targets: Box[];
	/** The other masks of the figure (context, drawn grey in the "all" mode), figure-local. */
	others: Box[];
	targetModes: MaskMode[];
	otherModes: MaskMode[];
}

/** The masks of an occlusion card for rendering; `pageCards` lets the neighbours' own modes count. */
export function maskInputs(card: OcclusionCard, pageCards: readonly CardDraft[]): MaskInputs {
	const fig = card.figureBbox;
	const modes = new Map<string, MaskMode>();
	for (const c of pageCards) if (c.type === "image_occlusion" && c.boxes.length > 0) modes.set(c.boxes[0]!.join(","), maskModeOf(c));
	const others = card.allBoxes.filter((b) => !card.boxes.some((t) => sameBox(t, b)));
	return {
		targets: card.boxes.map((b) => toLocal(b, fig)),
		others: others.map((b) => toLocal(b, fig)),
		targetModes: card.boxes.map(() => maskModeOf(card)),
		otherModes: others.map((b) => modes.get(b.join(",")) ?? "text"),
	};
}
