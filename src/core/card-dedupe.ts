/**
 * Duplicate detection for card drafts — text cards AND image occlusions
 * (Learnbox 2.0, 2026-11). Two stages here:
 *  - automatic (`autoMark`): only practically identical cards are thrown away
 *    (soft: restorable), at the end of a page and of a run;
 *  - review (`findGroups`): similar cards too, grouped, with a keep suggestion.
 * Deliberately sharper than a plain text similarity:
 *  - cloze cards with the same sentence but a DIFFERENT gap ask something else,
 *  - an occlusion is a duplicate only when label AND mask position agree (same
 *    page), or label AND the figure with the mask position (across pages, by
 *    picture hash) — the same label in two places of one picture stays.
 * Ported from MedAnki's medanki/dedupe.py (the Claude-assisted stage comes with
 * the focus screen).
 */

import type { CardDraft, DuplicateGroup } from "./contracts/create-cards.ts";
import type { Box } from "./contracts/page-layout.ts";
import { bboxOverlapRatio, CLOZE_RE, clozePlain, jaccard, norm, tokens } from "./card-util.ts";

/** Only (almost) identical cards are removed automatically. */
export const AUTO_THRESHOLD = 0.98;
export const DEFAULT_THRESHOLD = 0.8;
/** Largest Hamming distance (of 256 bits) for two figures to count as the same picture. */
const FIG_HASH_MAX = 26;
/** Very common words are not used to find candidates. */
const MAX_POSTING = 200;
/** Note prefix of an automatic removal. */
export const DUPLICATE_NOTE = "Duplicate of ";

interface Profile {
	card: CardDraft;
	kind: "text" | "occ";
	page: number;
	norm: string;
	tokens: Set<string>;
	isCloze: boolean;
	answers: Set<string>;
	answerTokens: Set<string>;
	labelNorm: string;
	labelTokens: Set<string>;
	box: Box | null;
	fig: Box | null;
	figHash: string | null;
}

const empty = (card: CardDraft, kind: Profile["kind"]): Profile => ({
	card,
	kind,
	page: card.page,
	norm: "",
	tokens: new Set(),
	isCloze: false,
	answers: new Set(),
	answerTokens: new Set(),
	labelNorm: "",
	labelTokens: new Set(),
	box: null,
	fig: null,
	figHash: null,
});

function profile(c: CardDraft): Profile {
	if (c.type === "image_occlusion") {
		return { ...empty(c, "occ"), labelNorm: norm(c.label), labelTokens: tokens(c.label), box: c.boxes[0] ?? null, fig: c.figureBbox, figHash: c.figHash ?? null };
	}
	if (c.type === "cloze") {
		const plain = clozePlain(c.text);
		const answers = [...c.text.matchAll(CLOZE_RE)].map((m) => m[2]!);
		return { ...empty(c, "text"), norm: norm(plain), tokens: tokens(plain), isCloze: true, answers: new Set(answers.map(norm)), answerTokens: tokens(answers.join(" ")) };
	}
	const text = `${c.front} ${c.back}`;
	return { ...empty(c, "text"), norm: norm(text), tokens: tokens(text) };
}

// ─── comparing two cards ─────────────────────────────────────────────────────

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Cloze: the same sentence with another gap is another thing to learn. */
function answersClose(a: Profile, b: Profile): boolean {
	if (sameSet(a.answers, b.answers)) return true;
	if (a.answerTokens.size > 0 && b.answerTokens.size > 0) return jaccard(a.answerTokens, b.answerTokens) >= 0.6;
	return false;
}

type Verdict = { score: number; reason: string } | null;

/** Box centre and relative area inside its figure. */
function relCenter(box: Box, fig: Box): [number, number, number] {
	const fw = Math.max(fig[2] - fig[0], 1e-6);
	const fh = Math.max(fig[3] - fig[1], 1e-6);
	return [((box[0] + box[2]) / 2 - fig[0]) / fw, ((box[1] + box[3]) / 2 - fig[1]) / fh, Math.max((box[2] - box[0]) * (box[3] - box[1]), 1e-9) / (fw * fh)];
}

function compareText(a: Profile, b: Profile, th: number): Verdict {
	if (a.tokens.size === 0 || b.tokens.size === 0) return null;
	if (a.isCloze && b.isCloze && !answersClose(a, b)) return null;
	if (a.norm === b.norm) return { score: 1, reason: "identical" };
	const j = jaccard(a.tokens, b.tokens);
	return j >= th ? { score: Math.round(j * 1000) / 1000, reason: "similar" } : null;
}

/** Hamming distance of two hex strings. */
export function hashDistance(a: string, b: string): number {
	let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
	let bits = 0;
	while (x > 0n) {
		bits += Number(x & 1n);
		x >>= 1n;
	}
	return bits;
}

function compareOcc(a: Profile, b: Profile): Verdict {
	if (!a.box || !b.box) return null;
	// The answer (label) is optional. If one card has none, the mask position alone decides — less certain, so
	// never removed automatically (score below AUTO_THRESHOLD).
	const unlabeled = !a.labelNorm || !b.labelNorm;
	const labelEq = Boolean(a.labelNorm) && a.labelNorm === b.labelNorm;
	if (!unlabeled && !labelEq && jaccard(a.labelTokens, b.labelTokens) < 0.8) return null;
	if (a.page === b.page) {
		if (bboxOverlapRatio(a.box, b.box) >= 0.5) return { score: unlabeled ? 0.95 : labelEq ? 1 : 0.9, reason: "same mask" };
		return null;
	}
	// Across pages: the same figure (picture hash) with the mask at the same relative place.
	if (!(a.figHash && b.figHash && a.fig && b.fig)) return null;
	if (hashDistance(a.figHash, b.figHash) > FIG_HASH_MAX) return null;
	const [ax, ay, aa] = relCenter(a.box, a.fig);
	const [bx, by, ba] = relCenter(b.box, b.fig);
	if (Math.abs(ax - bx) <= 0.08 && Math.abs(ay - by) <= 0.08 && aa / ba >= 0.5 && aa / ba <= 2) return { score: unlabeled ? 0.9 : labelEq ? 0.97 : 0.9, reason: "same figure" };
	return null;
}

function compare(a: Profile, b: Profile, th: number): Verdict {
	if (a.kind !== b.kind) return null;
	return a.kind === "text" ? compareText(a, b, th) : compareOcc(a, b);
}

// ─── groups ──────────────────────────────────────────────────────────────────

type Rank = [number, number, number, number, string];

/** Smallest = keep: the learner's own / edited cards first, then the more important tier, fewer warnings, the earlier page. */
export function keepRank(c: CardDraft): Rank {
	const protectedCard = c.manual || c.edited || c.restored;
	return [protectedCard ? 0 : 1, c.tier, c.warnings.length, c.page, c.id];
}

function compareRanks(a: readonly (number | string)[], b: readonly (number | string)[]): number {
	for (let i = 0; i < a.length; i++) {
		if (a[i]! < b[i]!) return -1;
		if (a[i]! > b[i]!) return 1;
	}
	return 0;
}

const pairKey = (i: number, j: number) => `${i}:${j}`;

function buildEdges(profs: readonly Profile[], threshold: number): Map<string, { i: number; j: number; verdict: NonNullable<Verdict> }> {
	const postings = new Map<string, number[]>();
	const post = (key: string, i: number) => {
		const list = postings.get(key);
		if (list) list.push(i);
		else postings.set(key, [i]);
	};
	profs.forEach((p, i) => {
		if (p.kind === "text") {
			for (const t of p.tokens) post(`t:${t}`, i);
		} else {
			post("occ:", i); // every occlusion (an unlabelled one is a wildcard)
			for (const t of p.labelTokens) post(`o:${t}`, i);
			if (p.labelNorm) post(`n:${p.labelNorm}`, i);
		}
	});

	const edges = new Map<string, { i: number; j: number; verdict: NonNullable<Verdict> }>();
	profs.forEach((p, i) => {
		const counts = new Map<number, number>();
		const bump = (j: number) => counts.set(j, (counts.get(j) ?? 0) + 1);
		let keys: string[];
		if (p.kind === "text") keys = [...p.tokens].map((t) => `t:${t}`);
		else if (p.labelNorm) keys = [...[...p.labelTokens].map((t) => `o:${t}`), `n:${p.labelNorm}`];
		else keys = ["occ:"]; // no label: compare with every occlusion
		for (const key of keys) {
			const list = postings.get(key) ?? [];
			if (key.startsWith("t:") && list.length > MAX_POSTING) continue;
			for (const j of list) if (j > i) bump(j);
		}
		if (p.kind === "occ" && p.labelNorm) {
			// a labelled card against the unlabelled ones that follow
			for (const j of postings.get("occ:") ?? []) if (j > i && !profs[j]!.labelNorm) bump(j);
		}
		for (const [j, cnt] of counts) {
			const q = profs[j]!;
			if (p.kind === "text" && cnt < Math.min(2, p.tokens.size, q.tokens.size)) continue;
			const verdict = compare(p, q, threshold);
			if (verdict && verdict.score >= threshold) edges.set(pairKey(i, j), { i, j, verdict });
		}
	});
	return edges;
}

/**
 * Groups of duplicate / similar cards (not deleted ones only). Each group lists the recommended card first.
 */
export function findGroups(pages: readonly { cards: readonly CardDraft[] }[], threshold = DEFAULT_THRESHOLD): DuplicateGroup[] {
	const cards = pages.flatMap((p) => p.cards).filter((c) => !c.deleted);
	const profs = cards.map(profile);
	const edges = buildEdges(profs, threshold);

	const parent = profs.map((_, i) => i);
	const find = (x: number): number => {
		while (parent[x] !== x) {
			parent[x] = parent[parent[x]!]!;
			x = parent[x]!;
		}
		return x;
	};
	for (const { i, j } of edges.values()) parent[find(i)] = find(j);

	const members = new Map<number, number[]>();
	const inEdge = new Set<number>();
	for (const { i, j } of edges.values()) {
		inEdge.add(i);
		inEdge.add(j);
	}
	for (const i of inEdge) {
		const root = find(i);
		const list = members.get(root);
		if (list) list.push(i);
		else members.set(root, [i]);
	}

	const groups: Omit<DuplicateGroup, "id">[] = [];
	for (const idxs of members.values()) {
		const set = new Set(idxs);
		const ge = [...edges.values()].filter((e) => set.has(e.i) && set.has(e.j));
		const ordered = [...idxs].sort((a, b) => compareRanks(keepRank(cards[a]!), keepRank(cards[b]!)));
		const keeper = cards[ordered[0]!]!;
		const rest = ordered.slice(1).sort((a, b) => compareRanks([cards[a]!.page, cards[a]!.id], [cards[b]!.page, cards[b]!.id]));
		const reasons = new Set(ge.map((e) => e.verdict.reason));
		groups.push({
			kind: profs[ordered[0]!]!.kind === "occ" ? "occlusion" : "text",
			reason: reasons.size === 1 ? [...reasons][0]! : "similar",
			score: Math.min(...ge.map((e) => e.verdict.score)),
			keep: keeper.id,
			cards: [keeper, ...rest.map((i) => cards[i]!)],
		});
	}
	groups.sort((a, b) => compareRanks([a.cards[0]!.page, a.keep], [b.cards[0]!.page, b.keep]));
	return groups.map((g, n) => ({ ...g, id: `g${n + 1}` }));
}

/**
 * Throws (almost) identical cards away (deleted + a note, restorable). The learner's own, edited and
 * restored cards are never removed automatically. Returns how many were removed.
 */
export function autoMark(pages: readonly { cards: readonly CardDraft[] }[], threshold = AUTO_THRESHOLD): number {
	let n = 0;
	for (const g of findGroups(pages, threshold)) {
		for (const c of g.cards.slice(1)) {
			if (c.manual || c.edited || c.restored) continue;
			c.deleted = true;
			c.note = `${DUPLICATE_NOTE}${g.keep}`;
			n++;
		}
	}
	return n;
}
