/**
 * The focus screen's server side (Learnbox 2.0, 2026-11): changing a draft card, making one by hand, moving a
 * mask or the part of the page a picture shows, choosing the cards to adopt, the duplicate review with Claude's
 * content check, and the focus topics of a job. Ported from MedAnki's app.py routes and pipeline.py
 * (`edit_occlusion_mask`, `edit_image_bbox`, `semantic_dedupe_advance`). The rules and the geometry are
 * core/card-edit.ts and core/card-dedupe.ts; here: the page files, the pictures, and Claude.
 *
 * Drafts of a page are changed one operation at a time. While a page is being processed, or its pictures are being
 * drawn again, a change to it is refused (409) rather than lost.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { realizeImage, realizeMedia } from "../agent/create/card-media.ts";
import { DEDUPE_SYSTEM, dedupePrompt } from "../agent/create/card-prompts.ts";
import { DEFAULT_THRESHOLD, DUPLICATE_NOTE, dedupeBrief, findGroups, resolveSemanticGroups, weakCandidates } from "../core/card-dedupe.ts";
import { applyCardEdit, applyImageEdit, applyMaskEdit, buildManualCard, CardEditError, nextCardIndex } from "../core/card-edit.ts";
import { cleanTopics } from "../core/card-util.ts";
import { CreateInputError, type CardsJob } from "../core/contracts.ts";
import type { CardDraft, CardPageResult, DuplicateGroup, DuplicateReview, SemanticStep } from "../core/contracts/create-cards.ts";
import type { PageLayout } from "../core/contracts/page-layout.ts";
import { pageNumbers } from "../core/create.ts";
import { FAST_MODEL, pageOfCardId, requireCards, savePage, type CardsDeps, defaultCardsDeps } from "./create-cards.ts";
import { type CreateDeps, askJson, defaultCreateDeps, errorText, pad } from "./create-shared.ts";

/** Pages whose pictures are being drawn right now ("job:page"). On globalThis for the same reason as the live runs. */
const drawing = globalThis as typeof globalThis & { __lbCardPagesDrawing?: Set<string> };
const busy = (drawing.__lbCardPagesDrawing ??= new Set<string>());
const pageKey = (id: string, page: number) => `${id}:${page}`;

/** A page of a job that may be changed now: its record and its drafts. */
function editablePage(id: string, page: number, deps: CreateDeps): { job: CardsJob; result: CardPageResult } {
	const job = requireCards(id, deps);
	const meta = job.pages[String(page)];
	if (!meta) throw new CreateInputError("Unknown page", 404);
	if (meta.status === "running" || busy.has(pageKey(id, page))) throw new CreateInputError("This page is being worked on — try again in a moment", 409);
	const result = deps.create.readCardPage(id, page);
	if (!result) throw new CreateInputError("This page has no cards yet — process it first", 409);
	return { job, result };
}

/** `editablePage`, held for the length of an async operation (released by the caller). */
function claimPage(id: string, page: number, deps: CreateDeps): { job: CardsJob; result: CardPageResult; release: () => void } {
	const held = editablePage(id, page, deps);
	const key = pageKey(id, page);
	busy.add(key);
	return { ...held, release: () => void busy.delete(key) };
}

function cardAt(id: string, cardId: string, deps: CreateDeps): { result: CardPageResult; card: CardDraft } {
	const page = pageOfCardId(cardId);
	if (page === null) throw new CreateInputError("Unknown card", 404);
	const { result } = editablePage(id, page, deps);
	const card = result.cards.find((c) => c.id === cardId);
	if (!card) throw new CreateInputError("Unknown card", 404);
	return { result, card };
}

const notAdopted = (card: CardDraft): void => {
	if (card.adopted) throw new CreateInputError("This card is already a study card — change it in Study", 409);
};

// ─── a card's fields ─────────────────────────────────────────────────────────

/**
 * Change a draft card: its texts, importance, tags, whether it is selected, throw it away or bring it back.
 * A card that is a study card now has to be changed in Study. An invalid change (empty side, broken gap text) is refused whole.
 */
export function patchCard(id: string, cardId: string, body: Record<string, unknown>, deps: CreateDeps = defaultCreateDeps()): CardDraft {
	const { result, card } = cardAt(id, cardId, deps);
	notAdopted(card);
	try {
		applyCardEdit(card, body);
	} catch (err) {
		if (err instanceof CardEditError) throw new CreateInputError(err.message, 400);
		throw err;
	}
	savePage(id, result, deps);
	return card;
}

/** Select or unselect many cards at once (the checklist). Returns how many changed. */
export function setInclude(id: string, input: { cardIds: readonly string[]; include: boolean }, deps: CreateDeps = defaultCreateDeps()): number {
	const byPage = new Map<number, Set<string>>();
	for (const cardId of input.cardIds) {
		const page = pageOfCardId(cardId);
		if (page === null) continue;
		byPage.set(page, (byPage.get(page) ?? new Set()).add(cardId));
	}
	const pages = [...byPage].map(([page, ids]) => ({ ...editablePage(id, page, deps), ids })); // all pages must be free before one is changed
	let changed = 0;
	for (const { result, ids } of pages) {
		let touched = false;
		for (const card of result.cards) {
			if (!ids.has(card.id) || card.adopted || card.include === input.include) continue;
			card.include = input.include;
			changed++;
			touched = true;
		}
		if (touched) savePage(id, result, deps);
	}
	return changed;
}

// ─── pictures ────────────────────────────────────────────────────────────────

/** The cached layout of a page; read from the PDF (and kept) when the page was never processed. */
async function layoutFor(job: CardsJob, page: number, deps: CardsDeps): Promise<PageLayout> {
	const cached = deps.create.readLayout(job.id, page);
	if (cached) return cached;
	const pdf = deps.library.pdfPath(job.lectureId);
	if (!pdf) throw new CreateInputError("The PDF is no longer in the library.", 409);
	const layout = (await deps.layouts(pdf, [page])).get(page);
	if (!layout) throw new Error(`page ${page} could not be read`);
	deps.create.writeLayout(job.id, page, layout);
	return layout;
}

/** Runs `draw` with the PDF open and the card pictures' folder; the PDF is closed afterwards. */
async function withPdf<T>(
	job: CardsJob,
	page: number,
	deps: CardsDeps,
	draw: (io: Parameters<typeof realizeMedia>[1]) => Promise<T>,
): Promise<T> {
	const pdf = deps.library.pdfPath(job.lectureId);
	if (!pdf) throw new CreateInputError("The PDF is no longer in the library.", 409);
	const session = await deps.openPdf(pdf);
	try {
		return await draw({ region: (box, px) => session.renderRegion(page, box, px), mediaDir: deps.create.mediaDir(job.id), recognize: deps.recognize });
	} finally {
		await session.close().catch(() => undefined);
	}
}

/**
 * Make a card yourself: question/answer (also both ways), or an image occlusion over an area drawn on the page
 * (`bbox`, page-normalised; `figure` = the part of the page the picture shows, else it is found). The page's
 * pictures are drawn again when it is an occlusion, since a card on a shared figure changes its siblings'.
 * Returns the page's cards.
 */
export async function addManualCard(id: string, page: number, payload: Record<string, unknown>, deps: CardsDeps = defaultCardsDeps()): Promise<CardDraft[]> {
	const { job, result, release } = claimPage(id, page, deps);
	try {
		const layout = await layoutFor(job, page, deps);
		const { card, reason } = buildManualCard(payload, layout, page, nextCardIndex(result.cards), job.settings);
		if (!card) throw new CreateInputError(reason, 400);
		result.cards.push(card);
		if (card.type === "image_occlusion") await withPdf(job, page, deps, (io) => realizeMedia(result, io));
		savePage(id, result, deps);
		return result.cards;
	} finally {
		release();
	}
}

/** Move or scale one card's mask and/or change the part of the page its picture shows; the page's pictures are drawn again. Returns the page's cards. */
export async function editMask(id: string, cardId: string, edit: { bbox?: unknown; figure?: unknown }, deps: CardsDeps = defaultCardsDeps()): Promise<CardDraft[]> {
	const page = pageOfCardId(cardId);
	if (page === null) throw new CreateInputError("Unknown card", 404);
	const { job, result, release } = claimPage(id, page, deps);
	try {
		const card = result.cards.find((c) => c.id === cardId);
		if (!card) throw new CreateInputError("Unknown card", 404);
		notAdopted(card);
		if (card.type !== "image_occlusion") throw new CreateInputError("This card has no mask", 400);
		if (!applyMaskEdit(result.cards, cardId, edit)) throw new CreateInputError("The mask or the picture box is not valid", 400);
		await withPdf(job, page, deps, (io) => realizeMedia(result, io));
		savePage(id, result, deps);
		return result.cards;
	} finally {
		release();
	}
}

/** Change the part of the page a card's context picture shows (a picture question, a process, a gap text over a figure). */
export async function editImage(id: string, cardId: string, bbox: unknown, deps: CardsDeps = defaultCardsDeps()): Promise<CardDraft> {
	const page = pageOfCardId(cardId);
	if (page === null) throw new CreateInputError("Unknown card", 404);
	const { job, result, release } = claimPage(id, page, deps);
	try {
		const card = result.cards.find((c) => c.id === cardId);
		if (!card) throw new CreateInputError("Unknown card", 404);
		notAdopted(card);
		const changed = applyImageEdit(result.cards, cardId, bbox);
		if (!changed) throw new CreateInputError("This card has no picture, or the box is not valid", 400);
		await withPdf(job, page, deps, (io) => realizeImage(card, io));
		if (changed.oldFile && changed.oldFile !== card.image?.file) fs.rmSync(path.join(deps.create.mediaDir(id), path.basename(changed.oldFile)), { force: true });
		savePage(id, result, deps);
		return card;
	} finally {
		release();
	}
}

/** The rendered page the focus screen shows (made by the run; 404 for a page not processed yet). */
export function pageImageFile(id: string, page: number, deps: CreateDeps = defaultCreateDeps()): string {
	const job = requireCards(id, deps);
	if (!job.pages[String(page)]) throw new CreateInputError("Unknown page", 404);
	const file = path.join(deps.create.workDir(id), "pages", `p${pad(page)}.png`);
	if (!fs.existsSync(file)) throw new CreateInputError("This page has not been processed yet", 404);
	return file;
}

// ─── the focus topics of a job ───────────────────────────────────────────────

/** Change the topics the cards should favour (or be limited to); they count for the pages processed from now on. */
export function setFocus(id: string, input: { focusTopics?: unknown; focusStrict?: unknown }, deps: CreateDeps = defaultCreateDeps()): { focusTopics: string[]; focusStrict: boolean } {
	requireCards(id, deps);
	const job = deps.create.update(id, (j) => {
		if (j.kind !== "cards") return;
		if ("focusTopics" in input) j.settings.focusTopics = cleanTopics(input.focusTopics);
		if ("focusStrict" in input) j.settings.focusStrict = input.focusStrict === true;
	});
	if (!job || job.kind !== "cards") throw new CreateInputError("Unknown job", 404);
	return { focusTopics: job.settings.focusTopics, focusStrict: job.settings.focusStrict };
}

// ─── duplicates ──────────────────────────────────────────────────────────────

function allPages(job: CardsJob, deps: CreateDeps): CardPageResult[] {
	return pageNumbers(job).flatMap((n) => {
		const result = deps.create.readCardPage(job.id, n);
		return result ? [result] : [];
	});
}

/** Groups of duplicate or similar cards of a job (the quick text/position comparison), and how many were removed on their own already. */
export function reviewDuplicates(id: string, threshold = DEFAULT_THRESHOLD, deps: CreateDeps = defaultCreateDeps()): DuplicateReview {
	const job = requireCards(id, deps);
	const pages = allPages(job, deps);
	const autoRemoved = pages.reduce((n, p) => n + p.cards.filter((c) => c.deleted && (c.note ?? "").startsWith(DUPLICATE_NOTE)).length, 0);
	return { groups: findGroups(pages, Math.min(1, Math.max(0.3, threshold))), autoRemoved };
}

/** Claude's groups found so far (the check is done step by step, see `semanticDedupeStep`). */
export function semanticGroups(id: string, deps: CreateDeps = defaultCreateDeps()): DuplicateGroup[] {
	const job = requireCards(id, deps);
	return resolveSemanticGroups(deps.create.readDedupeCache(id).groups, allPages(job, deps).flatMap((p) => p.cards));
}

/**
 * Throw the cards of duplicate groups away (soft, restorable; the note names the card kept). Cards that are study
 * cards already stay, and so does every card some group keeps — groups overlap (the quick comparison and Claude's
 * check can name the same card), and two groups keeping each other's cards must not remove both. Returns how many were removed.
 */
export function removeDuplicates(id: string, groups: readonly { keep: string; remove: readonly string[] }[], deps: CreateDeps = defaultCreateDeps()): number {
	const kept = new Set(groups.map((g) => g.keep));
	const keepOf = new Map<string, string>();
	for (const g of groups) for (const cardId of g.remove) if (!kept.has(cardId)) keepOf.set(cardId, g.keep);
	const pageNos = new Set([...keepOf.keys()].flatMap((cardId) => pageOfCardId(cardId) ?? []));
	const pages = [...pageNos].map((page) => editablePage(id, page, deps).result); // all pages must be free before one is changed
	let removed = 0;
	for (const result of pages) {
		let touched = false;
		for (const card of result.cards) {
			const keep = keepOf.get(card.id);
			if (!keep || card.deleted || card.adopted) continue;
			card.deleted = true;
			card.note = `${DUPLICATE_NOTE}${keep}`;
			removed++;
			touched = true;
		}
		if (touched) savePage(id, result, deps);
	}
	return removed;
}

/** Cards per call of the content check. */
const SEMANTIC_BATCH_CARDS = 30;

/**
 * ONE step of the content check: the next not-yet-checked candidate cards go to Claude, which says which of them
 * ask for the same thing. What was checked is kept per job — a card is asked about once, never again — so repeating
 * the step works through the whole backlog. Finds what the quick comparison misses: the same question worded
 * differently, or one label at quite another place of a figure. Nothing is removed on its own. A failed call
 * (sign-in, network, unreadable answer) leaves the progress untouched and reports the error.
 */
export async function semanticDedupeStep(
	id: string,
	opts: { threshold?: number; signal?: AbortSignal } = {},
	deps: CardsDeps = defaultCardsDeps(),
): Promise<SemanticStep> {
	const job = requireCards(id, deps);
	const pages = allPages(job, deps);
	const cache = deps.create.readDedupeCache(id);
	const checked = new Set(cache.checked);
	const groupsNow = () => resolveSemanticGroups(cache.groups, pages.flatMap((p) => p.cards));

	const weak = weakCandidates(pages, opts.threshold ?? DEFAULT_THRESHOLD);
	const unchecked = (w: { a: CardDraft; b: CardDraft }) => !checked.has(w.a.id) || !checked.has(w.b.id);
	const pending = weak.filter(unchecked).sort((x, y) => y.score - x.score);
	if (pending.length === 0) return { checkedNow: 0, remaining: 0, groups: groupsNow(), done: true, error: null };

	const batch: typeof pending = [];
	const byId = new Map<string, CardDraft>();
	for (const w of pending) {
		if (byId.size >= SEMANTIC_BATCH_CARDS && !byId.has(w.a.id) && !byId.has(w.b.id)) continue;
		byId.set(w.a.id, w.a);
		byId.set(w.b.id, w.b);
		batch.push(w);
		if (byId.size >= SEMANTIC_BATCH_CARDS) break;
	}

	let raw: Record<string, unknown>;
	try {
		raw = await askJson(deps, {
			prompt: dedupePrompt([...byId.values()].map(dedupeBrief), batch.map((w) => [w.a.id, w.b.id] as const)),
			system: DEDUPE_SYSTEM,
			cwd: deps.create.workDir(job.id),
			model: FAST_MODEL,
			signal: opts.signal ?? new AbortController().signal,
		});
	} catch (err) {
		return { checkedNow: 0, remaining: pending.length, groups: groupsNow(), done: false, error: errorText(err).slice(0, 200) };
	}

	const found = (Array.isArray(raw.groups) ? raw.groups : [])
		.map((ids) => (Array.isArray(ids) ? ids : []).filter((x): x is string => typeof x === "string" && byId.has(x)))
		.filter((ids) => ids.length >= 2)
		.map((ids) => ({ cards: ids }));
	for (const cardId of byId.keys()) checked.add(cardId);
	cache.checked = [...checked].sort();
	cache.groups = [...cache.groups, ...found];
	deps.create.writeDedupeCache(id, cache);

	const remaining = weak.filter(unchecked).length;
	return { checkedNow: byId.size, remaining, groups: groupsNow(), done: remaining === 0, error: null };
}
