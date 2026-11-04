/**
 * The model's answer for ONE page → validated, normalised DRAFT cards plus the
 * quality warnings (Learnbox 2.0, 2026-11). The answer is untrusted JSON: every
 * field is checked, unknown or forbidden card types are refused with a reason,
 * references (figure "F1", line ids "L4") are resolved against the page layout,
 * and the safety nets run — the legend fallback, one group per figure, the
 * vocabulary cap, the evidence check, and the removal of identical cards.
 * Pure; ported from MedAnki's medanki/cards.py (`normalize_page`).
 */

import type { CardDraft, CardPageResult, CardSettings, CardTier, DroppedCard, FrontBackCard, OcclusionCard } from "./contracts/create-cards.ts";
import { VOCAB_MAX_PER_PAGE } from "./contracts/create-cards.ts";
import type { PageLayout } from "./contracts/page-layout.ts";
import { autoMark } from "./card-dedupe.ts";
import {
	type CardBaseInit,
	cardLang,
	expandOcclusion,
	expandWholeImage,
	indexLines,
	LEGEND_HEADER,
	mergeOcclusionGroups,
} from "./card-occlusion.ts";
import { bboxOverlapRatio, CLOZE_RE, clampTier, cleanTags, cleanText, norm, padBbox, resolveRegion, resolveSource, tokens, union } from "./card-util.ts";

export type NormalizeSettings = Pick<CardSettings, "vocab" | "wholeImageCards" | "language" | "ioMode">;

/** Longest accepted texts before a quality warning. */
export const MAX_FRONT_CHARS = 260;
export const MAX_BACK_CHARS = 300;
/** The legend fallback covers at most this many entries of a legend. */
const LEGEND_FALLBACK_MAX = 16;
const REPLACED_NOTE = "Replaced by an occlusion of the legend (restorable)";

export const TIER_LABELS: Record<CardTier, string> = { 1: "Core knowledge", 2: "Good to know", 3: "Detail questions" };

/** Is this one of the evidence warnings? (The critic keeps those when it rewrites a card.) */
export const isEvidenceWarning = (w: string): boolean => /evidence/i.test(w);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const pad3 = (n: number) => String(n).padStart(3, "0");
export const cardId = (page: number, index: number): string => `p${pad3(page)}-c${String(index).padStart(2, "0")}`;

const VALID_TYPES = new Set(["cloze", "basic", "basic_reversed", "image_question", "process", "image_occlusion"]);
/** Types whose back side is a list/answer shown with a picture on the front. */
const IMAGE_TEXT_TYPES = new Set(["image_question", "process"]);

function newBase(page: number, raw: Record<string, unknown>): CardBaseInit {
	return {
		page,
		tier: clampTier(raw.priority),
		whyType: cleanText(raw.why_type).slice(0, 160),
		extra: cleanText(raw.extra),
		evidence: cleanText(raw.evidence).slice(0, 300),
		tags: cleanTags(raw.tags),
		warnings: [],
		deleted: false,
		include: true,
		manual: false,
		sourceIds: [],
		sourceBbox: null,
		image: null,
	};
}

/** A front/back card from a raw one; null with the reason when it is unusable. */
function normalizeTextCard(raw: Record<string, unknown>, base: CardBaseInit, ctype: string, layout: Pick<PageLayout, "figures">): { card: FrontBackCard | null; reason: string } {
	const front = cleanText(raw.front);
	const back = cleanText(raw.back);
	if (!front || !back) return { card: null, reason: "Front or back is empty" };
	const card: FrontBackCard = { ...base, id: "", type: ctype === "image_question" ? "basic" : (ctype as FrontBackCard["type"]), front, back };
	const img = raw.image;
	if (img) {
		const bbox = resolveRegion(img, layout);
		if (bbox) {
			const where = IMAGE_TEXT_TYPES.has(ctype) ? "front" : isRecord(img) && img.where === "front" ? "front" : "extra";
			card.image = { bbox: padBbox(bbox, 0.005), where, file: null };
		}
	}
	if (IMAGE_TEXT_TYPES.has(ctype) && !card.image) return { card: null, reason: `${ctype} without a valid picture region` };
	return { card, reason: "" };
}

// ─── quality ─────────────────────────────────────────────────────────────────

/** Cards the model typed "image_question" (a picture question): exempt from the evidence rule although they end up as "basic". */
const exemptImageQuestions = new WeakSet<CardDraft>();

// The wording below only knows German phrases — MedAnki's check as it was; English cards never trigger it.
const NEEDS_CONTEXT = /\b(oben|unten|siehe|wie im Text|diese[rsnm]? (?:Erkrankung|Krankheit|Medikament))\b/i;

export function qualityWarnings(c: CardDraft): string[] {
	const w: string[] = [];
	if (c.type === "basic" || c.type === "basic_reversed" || c.type === "process") {
		if (c.front.length > MAX_FRONT_CHARS) w.push("Question is very long");
		if (c.back.length > MAX_BACK_CHARS || c.back.split("\n").length - 1 >= 3) w.push("Answer is long / an enumeration — split it into several cards?");
		if (NEEDS_CONTEXT.test(c.front)) w.push("The question may be unclear without the page");
		if (c.type === "process" && c.back.split("\n").length - 1 < 1) w.push("A process with a single line — name the steps in order?");
	}
	// The whole-figure cloze has many gaps and little running text ON PURPOSE (the picture is the context): no prose-cloze checks.
	return w;
}

/** Hallucination guard: is the quoted evidence really on the page? */
export function evidenceWarnings(c: CardDraft, layout: Pick<PageLayout, "lines">): string[] {
	const pageText = layout.lines.map((l) => l.text).join(" ");
	if (pageText.length < 120) return []; // hardly any text layer (picture / scan page): cannot be checked
	const evidence = c.evidence ?? "";
	if (!evidence) {
		const exempt = c.type === "image_occlusion" || c.type === "process" || (c.type === "cloze" && c.legendCloze) || exemptImageQuestions.has(c);
		return exempt ? [] : ["No evidence quote given"];
	}
	const et = tokens(evidence);
	if (et.size === 0) return [];
	const pt = tokens(pageText);
	let shared = 0;
	for (const t of et) if (pt.has(t)) shared++;
	return shared / et.size < 0.7 ? ["Evidence quote not found in the page text — please check the content"] : [];
}

// ─── the legend fallback ─────────────────────────────────────────────────────

const plain = (s: string) => norm(s);

/**
 * Safety net against the model's misbehaviour: when the page has a SURELY recognised legend at the edge of a
 * figure (see legend.ts) and the model made no occlusion for it (typically only a picture question with
 * context), the code builds the occlusion group itself — one entry per legend line, exact boxes. Cards that
 * only ask the same legend names about the same picture are thrown away (restorable).
 */
function applyLegendFallback(cards: CardDraft[], layout: PageLayout, page: number, settings: NormalizeSettings, firstIndex: number): void {
	const legends = layout.legends.filter((lg) => lg.confident && lg.figure);
	if (legends.length === 0) return;
	const figs = new Map(layout.figures.map((f) => [f.id, f.bbox]));
	const lines = indexLines(layout);
	const byFigure = new Map<string, typeof legends>();
	for (const lg of legends) byFigure.set(lg.figure, [...(byFigure.get(lg.figure) ?? []), lg]);
	let idx = cards.reduce((max, c) => Math.max(max, Number(/-c(\d+)$/.exec(c.id)?.[1] ?? 0)), firstIndex - 1);
	const made = new Set<CardDraft>();

	for (const [figId, lgs] of byFigure) {
		const legendBbox = union(lgs.map((lg) => lg.bbox));
		const figBbox = figs.get(figId) ?? legendBbox;
		const occ = cards.filter((c): c is OcclusionCard => c.type === "image_occlusion" && !c.deleted);
		if (occ.some((c) => bboxOverlapRatio(c.figureBbox, figBbox) >= 0.5 || c.boxes.some((b) => bboxOverlapRatio(b, legendBbox) > 0.5))) continue; // the model already covered this figure / legend
		const entryIds = lgs.flatMap((lg) => lg.entries).filter((id) => lines.has(id)).slice(0, LEGEND_FALLBACK_MAX);
		if (entryIds.length < 2) continue;
		const raw = {
			type: "image_occlusion",
			header: LEGEND_HEADER[cardLang(settings)],
			mode: "one",
			figure: { ref: figId },
			occlusions: entryIds.map((id) => ({ label: lines.get(id)!.text, ids: [id] })),
		};
		const base: CardBaseInit = {
			...newBase(page, {}),
			whyType: "Legend at the edge of a figure recognised — occlusion made from the legend automatically",
		};
		const { cards: expanded } = settings.wholeImageCards ? expandWholeImage(raw, base, layout, lines, settings) : expandOcclusion(raw, base, layout, lines, settings);
		if (expanded.length === 0) continue;
		for (const c of expanded) {
			idx++;
			c.id = cardId(page, idx);
			c.note = "made from the legend — please check the selection";
			if (c.type === "image_occlusion") c.autoLegend = true;
			cards.push(c);
			made.add(c);
		}
		const names = new Set(entryIds.map((id) => plain(lines.get(id)!.text)));
		for (const c of cards) {
			if (made.has(c) || c.deleted || c.manual || c.type === "image_occlusion" || !c.image) continue;
			if (bboxOverlapRatio(c.image.bbox, figBbox) < 0.6) continue;
			const answers = c.type === "cloze" ? [...c.text.matchAll(CLOZE_RE)].map((m) => m[2]!) : [c.back];
			if (answers.some((a) => plain(a) !== "" && (names.has(plain(a)) || [...names].some((n) => n.length >= 4 && plain(a).includes(n))))) {
				c.deleted = true;
				c.note = REPLACED_NOTE;
			}
		}
	}
}

// ─── a page ──────────────────────────────────────────────────────────────────

/**
 * The model's answer for page `page` → the page result. `raw` is the parsed JSON object; nothing in it is
 * trusted. A skipped page returns no cards. New cards are numbered from `firstIndex` on (cards kept from an
 * earlier run of the page keep their ids).
 */
export function normalizePage(raw: Record<string, unknown>, layout: PageLayout, page: number, settings: NormalizeSettings, firstIndex = 1): CardPageResult {
	const result: CardPageResult = {
		page,
		pageType: String(raw.page_type ?? "").slice(0, 30),
		skip: Boolean(raw.skip),
		skipReason: cleanText(raw.skip_reason).slice(0, 200),
		topic: cleanText(raw.topic).slice(0, 100),
		status: "done",
		cards: [],
		dropped: [],
	};
	if (result.skip) {
		result.status = "skipped";
		return result;
	}

	const lines = indexLines(layout);
	const drop = (reason: string, rawCard: unknown) => result.dropped.push({ reason, raw: rawCard } satisfies DroppedCard);
	let idx = firstIndex - 1;
	for (const entry of Array.isArray(raw.cards) ? raw.cards : []) {
		if (!isRecord(entry)) continue;
		const ctype = String(entry.type ?? "").trim();
		if (ctype === "cloze") {
			// switched off (Daniel's wish): a question/answer card instead of a gap text
			drop("Cloze is switched off — please phrase it as a question/answer card", entry);
			continue;
		}
		if (!VALID_TYPES.has(ctype)) {
			drop(`Unknown type '${ctype}'`, entry);
			continue;
		}
		if (settings.vocab && ctype !== "basic_reversed") {
			// vocabulary sheet: word pairs only, never an occlusion or the like
			drop(`Vocabulary sheet: only vocabulary cards allowed (type '${ctype}' dropped)`, entry);
			continue;
		}
		const source = settings.vocab ? { ...entry, image: null, extra: "" } : entry;
		const base = newBase(page, source);

		if (ctype === "image_occlusion") {
			const { cards, dropped } = settings.wholeImageCards ? expandWholeImage(source, base, layout, lines, settings) : expandOcclusion(source, base, layout, lines, settings);
			for (const c of cards) {
				idx++;
				c.id = cardId(page, idx);
				result.cards.push(c);
			}
			result.dropped.push(...dropped);
			continue;
		}

		const ids = resolveSource(source, lines);
		base.sourceIds = ids.ids;
		base.sourceBbox = ids.bbox;
		const { card, reason } = normalizeTextCard(source, base, ctype, layout);
		if (!card) {
			drop(reason, entry);
			continue;
		}
		idx++;
		card.id = cardId(page, idx);
		if (ctype === "image_question") exemptImageQuestions.add(card);
		result.cards.push(card);
	}

	if (settings.vocab && result.cards.length > VOCAB_MAX_PER_PAGE) {
		// Safety net: only the most important words (lowest tier number first, then page order)
		const ranked = result.cards.map((c, i) => ({ c, i })).sort((a, b) => a.c.tier - b.c.tier || a.i - b.i);
		const keep = new Set(ranked.slice(0, VOCAB_MAX_PER_PAGE).map((r) => r.i));
		result.cards.forEach((c, i) => {
			if (!keep.has(i) && c.type !== "image_occlusion" && c.type !== "cloze") drop("Vocabulary sheet: only the most important words per page (limit)", { front: c.front, back: c.back });
		});
		result.cards = result.cards.filter((_, i) => keep.has(i));
		result.cards.forEach((c, n) => {
			c.id = cardId(page, firstIndex + n);
		});
	}
	if (!settings.vocab) applyLegendFallback(result.cards, layout, page, settings, firstIndex); // vocabulary sheets never get occlusions from legends
	mergeOcclusionGroups(result.cards);
	for (const c of result.cards) c.warnings.push(...qualityWarnings(c), ...evidenceWarnings(c, layout));
	autoMark([{ cards: result.cards }]);
	return result;
}
