/**
 * MedAnki's PDF jobs in Learnbox's shapes (Learnbox 2.0, 2026-11, Slice 8): what MedAnki stored per job — meta.json, one
 * `cards/pNNN.json` and one `pages/pNNN.layout.json` per page — read as untrusted JSON and turned into the card drafts, page
 * layouts, settings and counters of a Create cards job. Pure: the folder reading is server/create-migrate.ts.
 *
 * MedAnki wrote snake_case, Learnbox camelCase; `priority` became `tier`; the German density names became English ones. Cards
 * are carried over as they were (the pictures too: their file names stay). Two old card types have no counterpart and are
 * kept in the page's `dropped` list instead of being lost: a plain cloze card (MedAnki switched them off) — a picture question
 * is just a front/back card with the picture in front.
 */

import { cleanCardSettings } from "./card-settings.ts";
import { type Box, type PageFigure, type PageLayout, type PageLegend, type PageLine, type PageWord } from "./contracts/page-layout.ts";
import type {
	CardBase,
	CardDraft,
	CardImage,
	CardPageResult,
	CardSettings,
	CardTier,
	DroppedCard,
	GlossaryTerm,
	LegendClozeCard,
	OcclusionCard,
} from "./contracts/create-cards.ts";
import type { CreateJobState, CreatePage } from "./contracts/create.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const flag = (v: unknown, fallback = false): boolean => (typeof v === "boolean" ? v : fallback);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const whole = (v: unknown): number | null => {
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
	return Number.isInteger(n) ? n : null;
};

/** Four finite numbers (the old files already passed MedAnki's own checks; this only guards the shape). */
function box(v: unknown): Box | null {
	if (!Array.isArray(v) || v.length !== 4) return null;
	const b = v.map(Number);
	return b.every(Number.isFinite) ? (b as Box) : null;
}

const boxList = (v: unknown): Box[] => (Array.isArray(v) ? v.map(box).filter((b): b is Box => b !== null) : []);

// ─── the id MedAnki's Anki push put on a card ─────────────────────────────────

/** MedAnki's `ankiconnect._tag`: the hidden tag of a pushed card (`MedAnkiID_<job>_<card>`), the link to its study card. */
export function legacyCardTag(jobId: string, cardId: string): string {
	const tag = `${jobId}_${cardId}`
		.replace(/[^\p{L}\p{N}_-]/gu, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `MedAnkiID_${tag || "Dokument"}`;
}

// ─── settings ─────────────────────────────────────────────────────────────────

const DENSITY: Record<string, CardSettings["density"]> = { knapp: "brief", normal: "normal", ausführlich: "thorough", ausfuehrlich: "thorough", konzept: "concept" };
const KIND: Record<string, CardSettings["kind"]> = { vorlesung: "lecture", praktikum: "practical" };

/** MedAnki's job settings (German density / kind names, snake_case) → a cards job's settings. */
export function legacyCardSettings(raw: unknown): CardSettings {
	const r = isRecord(raw) ? raw : {};
	const density = text(r.density).trim().toLowerCase();
	return cleanCardSettings({
		model: r.model,
		density: DENSITY[density] ?? density,
		language: r.language,
		ioMode: r.io_mode,
		latinTerms: r.latin_terms,
		wholeImageCards: r.whole_image_cards,
		focusTopics: r.focus_topics,
		focusStrict: r.focus_strict,
		kind: KIND[text(r.kind).trim().toLowerCase()] ?? r.kind,
		vocab: r.vocab,
		vocabLang: r.vocab_lang,
		pageFrom: r.page_from,
		pageTo: r.page_to,
		concurrency: r.concurrency,
	});
}

/** MedAnki's job state: only a finished run stays "done"; anything else was cut off (and can be started again). */
export const legacyJobState = (state: unknown): CreateJobState => (state === "done" ? "done" : "stopped");

/** The glossary list ({canonical, variants}). */
export function legacyGlossary(raw: unknown): GlossaryTerm[] {
	if (!Array.isArray(raw)) return [];
	const out: GlossaryTerm[] = [];
	for (const t of raw) {
		if (!isRecord(t) || !text(t.canonical).trim()) continue;
		out.push({ canonical: text(t.canonical), variants: strings(t.variants) });
	}
	return out;
}

/** MedAnki's heading list is by position in the page range (the first entry is the range's first page). */
export function legacyHeadings(raw: unknown, pageFrom: number): Record<string, string> {
	const out: Record<string, string> = {};
	if (Array.isArray(raw)) raw.forEach((h, i) => typeof h === "string" && h.trim() && (out[String(pageFrom + i)] = h));
	return out;
}

// ─── cards ────────────────────────────────────────────────────────────────────

function legacyImage(v: unknown): CardImage | null {
	if (!isRecord(v)) return null;
	const bbox = box(v.bbox);
	if (!bbox) return null;
	return { bbox, where: v.where === "front" ? "front" : "extra", file: text(v.file) || null };
}

/** One old card → a draft, or (a type Learnbox has no place for, a card missing its text) the reason it could not come along. */
export function legacyCard(raw: unknown, page: number): { card: CardDraft } | { dropped: DroppedCard } {
	const drop = (reason: string) => ({ dropped: { reason, raw } });
	if (!isRecord(raw)) return drop("Not a card record.");
	const id = text(raw.id).trim();
	if (!id) return drop("A card without an id.");
	const tier = whole(raw.priority);
	const base: CardBase = {
		id,
		page: whole(raw.page) ?? page,
		tier: (tier !== null && tier >= 1 && tier <= 3 ? tier : 2) as CardTier,
		whyType: text(raw.why_type),
		extra: text(raw.extra),
		evidence: text(raw.evidence),
		tags: strings(raw.tags),
		warnings: strings(raw.warnings),
		deleted: flag(raw.deleted),
		include: flag(raw.include, true),
		manual: flag(raw.manual),
		sourceIds: strings(raw.source_ids),
		sourceBbox: box(raw.source_bbox),
		image: legacyImage(raw.image),
		...(text(raw.note) ? { note: text(raw.note) } : {}),
		...(raw.edited === true ? { edited: true } : {}),
		...(raw.restored === true ? { restored: true } : {}),
		...(Array.isArray(raw.prev_tags) ? { prevTags: strings(raw.prev_tags) } : {}),
	};
	const type = text(raw.type);

	if (type === "basic" || type === "basic_reversed" || type === "process" || type === "image_question") {
		if (typeof raw.front !== "string" || typeof raw.back !== "string") return drop("A front/back card without its text.");
		// MedAnki itself made a picture question a front/back card with the picture in front
		return { card: { ...base, type: type === "image_question" ? "basic" : type, front: raw.front, back: raw.back } };
	}
	if (type === "cloze") {
		if (raw.legend_cloze !== true) return drop("An old cloze card (MedAnki does not offer them any more).");
		if (typeof raw.text !== "string") return drop("A figure cloze without its text.");
		const markerBoxes: Record<string, Box> = {};
		if (isRecord(raw.marker_boxes)) for (const [k, b] of Object.entries(raw.marker_boxes)) if (box(b)) markerBoxes[k] = box(b)!;
		const markerNums: Record<string, string> = {};
		if (isRecord(raw.marker_nums)) for (const [k, n] of Object.entries(raw.marker_nums)) if (typeof n === "string") markerNums[k] = n;
		const card: LegendClozeCard = { ...base, type: "cloze", text: raw.text, legendCloze: true, markerBoxes, markerNums };
		return { card };
	}
	if (type === "image_occlusion") {
		const figureBbox = box(raw.figure_bbox);
		if (!figureBbox) return drop("An occlusion card without its figure.");
		const boxes = boxList(raw.boxes);
		const card: OcclusionCard = {
			...base,
			type: "image_occlusion",
			header: text(raw.header),
			mode: raw.mode === "all" ? "all" : "one",
			figureBbox,
			figureExact: flag(raw.figure_exact),
			maskExact: flag(raw.mask_exact),
			label: text(raw.label),
			hint: text(raw.hint),
			boxes,
			markerBbox: box(raw.marker_bbox),
			allBoxes: boxList(raw.all_boxes).length > 0 ? boxList(raw.all_boxes) : boxes,
			needsCheck: flag(raw.needs_check),
			...(raw.auto_legend === true ? { autoLegend: true } : {}),
			questionFile: text(raw.question_file) || null,
			answerFile: text(raw.answer_file) || null,
			...(text(raw.fig_hash) ? { figHash: text(raw.fig_hash) } : {}),
			...(whole(raw.mask_v) !== null ? { maskV: whole(raw.mask_v)! } : {}),
		};
		return { card };
	}
	return drop(`An unknown card type "${type}".`);
}

/** One old page file → the page's drafts (null when the file is not a page record). */
export function legacyPageResult(raw: unknown, page: number): CardPageResult | null {
	if (!isRecord(raw) || !Array.isArray(raw.cards)) return null;
	const cards: CardDraft[] = [];
	const dropped: DroppedCard[] = Array.isArray(raw.dropped)
		? raw.dropped.map((d) => (isRecord(d) ? { reason: text(d.reason) || "Dropped in MedAnki.", raw: d.raw ?? d } : { reason: "Dropped in MedAnki.", raw: d }))
		: [];
	for (const c of raw.cards) {
		const out = legacyCard(c, page);
		if ("card" in out) cards.push(out.card);
		else dropped.push(out.dropped);
	}
	const skip = flag(raw.skip);
	return {
		page,
		pageType: text(raw.page_type),
		skip,
		skipReason: text(raw.skip_reason),
		topic: text(raw.topic),
		status: skip ? "skipped" : "done",
		cards,
		dropped,
	};
}

/** The job's counters for a page (what the page list shows) — the same figures a fresh run would have written. */
export function legacyPageEntry(old: unknown, result: CardPageResult | null): CreatePage {
	const o = isRecord(old) ? old : {};
	const live = result?.cards.filter((c) => !c.deleted) ?? [];
	const status = result !== null || o.status === "done" || o.status === "skipped" ? "done" : o.status === "error" ? "error" : "pending";
	return {
		status,
		...(status === "error" && text(o.error) ? { error: text(o.error).slice(0, 400) } : {}),
		count: live.length,
		adopted: live.filter((c) => c.adopted).length,
		...(result ? { topic: result.topic, skipped: result.skip } : text(o.topic) ? { topic: text(o.topic) } : {}),
	};
}

/** Every picture file a draft names (to copy only what is used). */
export function legacyMediaOf(c: CardDraft): string[] {
	const names = c.type === "image_occlusion" ? [c.questionFile, c.answerFile] : [c.image?.file];
	return names.filter((n): n is string => Boolean(n));
}

// ─── page layouts ─────────────────────────────────────────────────────────────

function legacyWord(v: unknown): PageWord | null {
	if (!isRecord(v) || typeof v.t !== "string") return null;
	const b = box(v.b);
	return b ? { t: v.t, b } : null;
}

function legacyLine(v: unknown): PageLine | null {
	if (!isRecord(v) || typeof v.id !== "string" || typeof v.text !== "string") return null;
	const bbox = box(v.bbox);
	if (!bbox) return null;
	const src = v.src === "ocr" || v.src === "legend" ? v.src : "pdf";
	const words = Array.isArray(v.words) ? v.words.map(legacyWord).filter((w): w is PageWord => w !== null) : null;
	return {
		id: v.id,
		text: v.text,
		bbox,
		tight: box(v.tight),
		size: typeof v.size === "number" ? v.size : 0,
		src,
		bold: flag(v.bold),
		italic: flag(v.italic),
		underline: flag(v.underline),
		inFigure: flag(v.in_figure),
		...(words ? { words } : {}),
		...(typeof v.marker === "string" ? { marker: v.marker } : {}),
		...(typeof v.legend === "string" ? { legend: v.legend } : {}),
		...(typeof v.line === "string" ? { line: v.line } : {}),
	};
}

function legacyFigure(v: unknown): PageFigure | null {
	if (!isRecord(v) || typeof v.id !== "string") return null;
	const bbox = box(v.bbox);
	if (!bbox) return null;
	return { id: v.id, kind: v.kind === "vector" ? "vector" : "raster", bbox, ...(Array.isArray(v.legends) ? { legends: strings(v.legends) } : {}) };
}

function legacyLegend(v: unknown): PageLegend | null {
	if (!isRecord(v) || typeof v.id !== "string") return null;
	const bbox = box(v.bbox);
	if (!bbox) return null;
	const kind = v.kind === "lettered" || v.kind === "swatch" ? v.kind : "numbered";
	return { id: v.id, kind, figure: text(v.figure), bbox, entries: strings(v.entries), markersInFigure: whole(v.markers_in_figure) ?? 0, confident: flag(v.confident) };
}

/** MedAnki's stored `pages/pNNN.layout.json` → the page layout (null when it is not one). The line ids stay, so the cards' source ids still point at their lines. */
export function legacyLayout(raw: unknown): PageLayout | null {
	if (!isRecord(raw) || !Array.isArray(raw.lines) || !Array.isArray(raw.figures)) return null;
	return {
		widthPt: typeof raw.width_pt === "number" ? raw.width_pt : 0,
		heightPt: typeof raw.height_pt === "number" ? raw.height_pt : 0,
		lines: raw.lines.map(legacyLine).filter((l): l is PageLine => l !== null),
		figures: raw.figures.map(legacyFigure).filter((f): f is PageFigure => f !== null),
		legends: Array.isArray(raw.legends) ? raw.legends.map(legacyLegend).filter((l): l is PageLegend => l !== null) : [],
		chars: whole(raw.chars) ?? 0,
		title: text(raw.title),
	};
}
