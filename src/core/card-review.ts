/**
 * The two optional passes around the card generator (Learnbox 2.0, 2026-11) — the pure part of them:
 *  - the critic: cards that normalisation flagged get a second look together with the page text; the verdict
 *    keeps ("ok"), rewrites ("fix") or soft-deletes ("delete") a card. A failed call leaves every card as it was.
 *  - the term glossary: one small list of canonical spellings for the whole document, so a page-40 card does not
 *    spell "Troponin T" differently from a page-3 card.
 * Ported from MedAnki's critique.py and glossary.py; the model calls live in server/create-cards.ts.
 */

import { cleanText, clozeOk } from "./card-util.ts";
import { isEvidenceWarning, qualityWarnings } from "./card-normalize.ts";
import type { CardDraft, GlossaryTerm } from "./contracts/create-cards.ts";
import type { PageLayout } from "./contracts/page-layout.ts";

export const MAX_FLAGGED_PER_CALL = 12;
/** The critic sees this much of the page text. */
export const CRITIC_PAGE_CHARS = 6000;
export const GLOSSARY_SAMPLE_PAGES = 6;
export const GLOSSARY_MAX_CHARS = 6000;
const GLOSSARY_MAX_TERMS = 30;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ─── critic ──────────────────────────────────────────────────────────────────

/** The cards the critic looks at: flagged, not deleted, at most one call's worth. */
export const flaggedCards = (cards: readonly CardDraft[]): CardDraft[] => cards.filter((c) => c.warnings.length > 0 && !c.deleted).slice(0, MAX_FLAGGED_PER_CALL);

/** The page text as the critic gets it: "[L1] text", empty lines left out. */
export function criticPageText(layout: Pick<PageLayout, "lines">): string {
	return layout.lines
		.filter((ln) => ln.text.trim() !== "")
		.map((ln) => `[${ln.id}] ${ln.text}`)
		.join("\n")
		.slice(0, CRITIC_PAGE_CHARS);
}

/** What the critic sees of a card (the picture itself is not judged, only header and answer text). */
export function cardBrief(c: CardDraft): Record<string, unknown> {
	const out: Record<string, unknown> = { id: c.id, type: c.type, warnings: c.warnings };
	if (c.type === "cloze") out.text = c.text;
	else if (c.type === "image_occlusion") {
		out.header = c.header;
		out.label = c.label;
	} else {
		out.front = c.front;
		out.back = c.back;
	}
	return out;
}

const addNote = (c: CardDraft, text: string): void => {
	c.note = (c.note ? `${c.note} ` : "") + text;
};

/** Applies the critic's verdicts to the flagged cards in place. Returns how many cards it changed. */
export function applyVerdicts(flagged: readonly CardDraft[], raw: unknown): number {
	const byId = new Map(flagged.map((c) => [c.id, c]));
	const verdicts = isRecord(raw) && Array.isArray(raw.cards) ? raw.cards : [];
	let changed = 0;
	for (const v of verdicts) {
		if (!isRecord(v)) continue;
		const c = byId.get(String(v.id ?? ""));
		if (!c) continue;
		const verdict = String(v.verdict ?? "").trim().toLowerCase();
		const reason = String(v.reason ?? "").slice(0, 160);
		if (verdict === "delete") {
			c.deleted = true;
			addNote(c, `Critic: ${reason || "unclear / not backed by the page"}`);
			changed++;
		} else if (verdict === "fix") {
			let fixed = false;
			if (c.type === "cloze" && v.text) {
				const text = cleanText(v.text);
				if (clozeOk(text).ok) {
					c.text = text;
					fixed = true;
				}
			} else if ((c.type === "basic" || c.type === "basic_reversed" || c.type === "process") && v.front && v.back) {
				c.front = cleanText(v.front);
				c.back = cleanText(v.back);
				fixed = true;
			}
			if (fixed) {
				const evidence = c.warnings.filter(isEvidenceWarning);
				c.warnings = [...qualityWarnings(c), ...evidence];
				addNote(c, `Critic: wording adjusted${reason ? ` (${reason})` : ""}`);
				changed++;
			}
		} else if (verdict === "ok") {
			c.warnings = []; // checked again against the same page text and confirmed
			changed++;
		}
	}
	return changed;
}

// ─── glossary ────────────────────────────────────────────────────────────────

/** Pages spread over the document (not only its beginning — inconsistent spelling shows up late). */
export function samplePages(pages: readonly number[], max = GLOSSARY_SAMPLE_PAGES): number[] {
	const nums = [...pages].sort((a, b) => a - b);
	if (nums.length <= max) return nums;
	const step = nums.length / max;
	return [...new Set(Array.from({ length: max }, (_, i) => nums[Math.floor(i * step)]!))].sort((a, b) => a - b);
}

/** The page text for the model: lines in reading order, "★ " in front of what the author emphasised. */
export function pageText(layout: Pick<PageLayout, "lines">): string {
	const out: string[] = [];
	for (const ln of layout.lines) {
		if (ln.src === "legend") continue; // legend entries already stand as normal lines
		const t = ln.text.trim();
		if (t) out.push((ln.bold || ln.italic || ln.underline ? "★ " : "") + t);
	}
	return out.join("\n");
}

/** The sample pages as one text block ("=== Seite 3 ===" …), cut to what one call can carry. */
export function glossaryMaterial(parts: readonly { page: number; layout: Pick<PageLayout, "lines"> }[]): string {
	const blocks: string[] = [];
	for (const { page, layout } of parts) {
		const t = pageText(layout);
		if (t.trim()) blocks.push(`=== Seite ${page} ===\n${t}`);
	}
	return blocks.join("\n\n").slice(0, GLOSSARY_MAX_CHARS);
}

/** The model's glossary answer → clean terms (a canonical spelling and at least one variant it replaces). */
export function parseGlossary(raw: unknown): GlossaryTerm[] {
	const terms: GlossaryTerm[] = [];
	const list = isRecord(raw) && Array.isArray(raw.terms) ? raw.terms : [];
	for (const t of list) {
		if (!isRecord(t)) continue;
		const canonical = String(t.canonical ?? "").trim();
		const variants = (Array.isArray(t.variants) ? t.variants : []).map((v) => String(v).trim()).filter(Boolean);
		if (canonical && variants.length > 0) terms.push({ canonical: canonical.slice(0, 60), variants: variants.slice(0, 5) });
	}
	return terms.slice(0, GLOSSARY_MAX_TERMS);
}
