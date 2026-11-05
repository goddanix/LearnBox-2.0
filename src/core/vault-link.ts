/**
 * Linking the notes of a vault (Learnbox 2.0, 2026-11): the pure rules of MedAnki's linker.py. Related notes — across
 * courses and PDFs too (heart anatomy ↔ heart failure ↔ membrane potential) — get a section "Verwandte Themen" with
 * links, so a net of topics appears in Obsidian's graph. The steps: read each note (title, folder = course / script,
 * tags, headings, **bold** key terms, key points); similarity by TF-IDF (title, tags, headings and key terms count
 * more) and the best candidates per note; Claude checks the candidates (without Claude: the choice by similarity);
 * the sections are written, mutual and at most MAX_LINKS per note.
 *
 * Only notes the app wrote (`medanki_id`) are changed. The reader's own notes are read and may be the target of a
 * link (Obsidian shows it there as a backlink), but their files stay as they are. The files and the model call are in
 * store/vault.ts and server/create-notes.ts; tests/vault-link.test.ts compares these functions with MedAnki's own output.
 */

import type { LinkResult } from "./contracts/create-notes.ts";
import { byCodePoint, removeLinksBlock, slug } from "./vault-text.ts";

/** Links per note in the section "Verwandte Themen". */
export const MAX_LINKS = 6;
/** Candidates per source note for Claude's check. */
export const CANDIDATES = 8;
/** Claude picks at most this many (and so does the choice by similarity). */
export const PICK = 5;
/** Source notes per Claude call. */
export const BATCH = 10;
/** Below this a candidate is plain noise. */
export const MIN_SIM = 0.05;
/** Without Claude it is stricter, as nobody checks the choice. */
export const MIN_SIM_NO_LLM = 0.12;
/** Shared meaningful terms (a title or key term counts as 2). */
export const MIN_SHARED = 2;
/** Notes of one script are close to each other anyway → less weight. */
export const SAME_DOC_FACTOR = 0.6;
/** Terms in more than half of all notes tell nothing apart. */
export const COMMON_DF = 0.5;

/** Words that say nothing about a topic (German and English filler, generic headings), sorted. */
export const STOP: ReadonlySet<string> = new Set(
	[
		"aber", "about", "after", "alle", "allem", "allen", "aller", "alles", "also", "and", "are", "auch", "auf",
		"aufbau", "aus", "basic", "basics", "been", "before", "bei", "beim", "being", "beschreibt", "between", "bis",
		"both", "bzw", "can", "causes", "clinical", "dabei", "dafür", "dagegen", "damit", "dann", "dass", "dazu",
		"definition", "dem", "den", "denn", "der", "des", "diagnosis", "diagnostics", "diagnostik", "die", "diese",
		"diesem", "diesen", "dieser", "dieses", "doch", "durch", "during", "each", "eine", "einem", "einen", "einer",
		"eines", "einführung", "einige", "for", "from", "für", "gegen", "gibt", "grundlage", "grundlagen", "has", "hat",
		"have", "hier", "ihre", "ihrer", "into", "introduction", "ist", "kann", "kein", "keine", "klinik", "können", "man",
		"mehr", "mit", "more", "most", "muss", "nach", "nicht", "noch", "not", "note", "notes", "notiz", "notizen", "nur",
		"oder", "ohne", "only", "other", "over", "overview", "page", "pages", "related", "seite", "seiten", "sich",
		"siehe", "sind", "some", "sowie", "structure", "such", "summary", "symptome", "symptoms", "than", "that", "the",
		"their", "then", "therapie", "therapy", "there", "these", "this", "those", "und", "under", "uns", "unter",
		"ursachen", "vom", "von", "vor", "war", "was", "wenn", "werden", "were", "which", "while", "who", "wie", "will",
		"wird", "with", "wurde", "zum", "zur", "zwischen", "über", "überblick", "übersicht",
	],
);

// Python's re.M anchors, written out (see vault-text.ts).
const BOL = "(?:^|(?<=\\n))";
const EOL = "(?=\\n|$)";
const BOLD = /\*\*([^*\n]{3,60})\*\*/gu;
const WIKI = /!?\[\[[^\]]*\]\]/g;
const FM = /^---\n([\s\S]*?)\n---\n?/;

/** A note of the vault as the linker reads it. */
export interface VaultNote {
	id: string;
	/** Path in the vault without ".md" (the way Obsidian links). */
	rel: string;
	/** Path in the vault with ".md". */
	file: string;
	title: string;
	subject: string;
	doc: string;
	/** The running number in the file name ("03 Title.md"). */
	ix: number | null;
	/** Written by the app: only then is the file changed. */
	owned: boolean;
	abstract: string;
	/** Key terms (bold), for display and the reason. */
	terms: string[];
	weights: Map<string, number>;
	text: string;
}

export interface Candidate {
	id: string;
	score: number;
	shared: string[];
}

export type Picked = Map<string, Map<string, string>>;
export interface LinkRow {
	id: string;
	why: string;
	score: number;
}

const chars = (s: string): string[] => [...s];

function stripSet(s: string, set: string): string {
	const c = chars(s);
	let a = 0;
	let b = c.length;
	while (a < b && set.includes(c[a]!)) a++;
	while (b > a && set.includes(c[b - 1]!)) b--;
	return c.slice(a, b).join("");
}

// ─── reading ─────────────────────────────────────────────────────────────────

function tokens(s: string): string[] {
	return (s.toLowerCase().match(/[\p{L}\p{Nl}\p{No}]{4,}/gu) ?? []).filter((w) => !STOP.has(w));
}

function fmValue(fm: string, key: string): string {
	const m = new RegExp(`${BOL}${key}:\\s*([^\\n]+?)\\s*${EOL}`).exec(fm);
	return m ? stripSet(m[1]!, "\"'") : "";
}

function fmTags(fm: string): string[] {
	const at = fm.indexOf("tags:");
	const block = at >= 0 ? fm.slice(at + 5).split("\n\n")[0]! : "";
	const out = [...block.matchAll(new RegExp(`${BOL}\\s+-\\s+(\\S+)\\s*${EOL}`, "g"))].map((m) => m[1]!);
	const inline = new RegExp(`${BOL}tags:\\s*\\[([^\\n]*?)\\]\\s*${EOL}`).exec(fm);
	return [...out, ...(inline ? inline[1]!.split(",").map((t) => stripSet(t, " \"'")) : [])];
}

/** A note from its text and its place in the vault (`file` with ".md", slash-separated). Null for the overview notes of a course. */
export function parseNote(text: string, file: string, idx: number): VaultNote | null {
	const m = FM.exec(text);
	const fm = m ? m[1]! : "";
	let body = m ? text.slice(m[0].length) : text;
	if (fm.includes("medanki_moc: true")) return null;
	const parts = file.split("/");
	const owned = new RegExp(`${BOL}medanki_id:`).test(fm);
	body = removeLinksBlock(body);
	const h1 = new RegExp(`${BOL}# ([^\\n]+)${EOL}`).exec(body);
	const base = parts[parts.length - 1]!;
	const dot = base.lastIndexOf(".");
	const rawStem = dot > 0 ? base.slice(0, dot) : base;
	const stem = rawStem.replace(/^\d+\s+/, "");
	const title = (h1 ? h1[1]!.trim() : stem) || stem;
	const subject = fmValue(fm, "fach") || (parts.length > 2 ? parts[0]! : "");
	const doc = parts.length > 2 ? parts[1]! : "";
	const ixm = /^(\d+)\s/.exec(rawStem);
	const heads = [...body.matchAll(new RegExp(`${BOL}#{2,3}\\s+([^\\n]+?)\\s*${EOL}`, "g"))].map((x) => x[1]!).filter((x) => !["eigene notizen", "verwandte themen"].includes(x.toLowerCase()));
	const bold = [...body.matchAll(BOLD)].map((x) => x[1]!.trim());
	let abstract = [...body.matchAll(new RegExp(`${BOL}>\\s*-\\s+([^\\n]+)${EOL}`, "g"))]
		.slice(0, 4)
		.map((x) => x[1]!)
		.join(" ");
	abstract = chars(abstract.replace(BOLD, "$1")).slice(0, 320).join("");
	let clean = body.replace(BOLD, "$1").replace(WIKI, " ");
	clean = clean.replace(new RegExp(`${BOL}>\\s*\\[![\\p{L}\\p{N}_-]+\\]\\s*`, "gu"), "");
	const w = new Map<string, number>();
	const add = (toks: readonly string[], n: number) => {
		for (const t of toks) w.set(t, (w.get(t) ?? 0) + n);
	};
	add(tokens(title), 4);
	for (const tag of fmTags(fm)) {
		if (tag !== "medizinstudium" && tag.toLowerCase() !== slug(subject).toLowerCase()) add(tokens(tag.replace(/-/g, " ")), 3);
	}
	for (const x of heads) add(tokens(x), 2);
	for (const x of bold) add(tokens(x), 3);
	add(tokens(clean), 1);
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const x of bold) {
		if (!seen.has(x.toLowerCase()) && tokens(x).length > 0) {
			seen.add(x.toLowerCase());
			terms.push(x);
		}
	}
	return {
		id: `n${idx}`,
		rel: file.replace(/\.md$/, ""),
		file,
		title,
		subject,
		doc,
		ix: ixm ? Number.parseInt(ixm[1]!, 10) : null,
		owned,
		abstract,
		terms: terms.slice(0, 8),
		weights: w,
		text,
	};
}

// ─── similarity ──────────────────────────────────────────────────────────────

/** id → the candidates, most alike first (TF-IDF cosine). */
export function similarities(notes: readonly VaultNote[]): Map<string, Candidate[]> {
	const n = notes.length;
	const df = new Map<string, number>();
	for (const note of notes) for (const t of note.weights.keys()) df.set(t, (df.get(t) ?? 0) + 1);
	const idf = new Map<string, number>();
	for (const [t, c] of df) idf.set(t, Math.log((n + 1) / (c + 1)) + 1);
	const common = new Set<string>();
	for (const [t, c] of df) if (n >= 6 && c / n > COMMON_DF) common.add(t);
	const vecs = notes.map((note) => {
		const v = new Map<string, number>();
		for (const [t, w] of note.weights) if (!common.has(t)) v.set(t, (1 + Math.log(w)) * idf.get(t)!);
		let sum = 0;
		for (const x of v.values()) sum += x * x;
		return { v, norm: Math.sqrt(sum) || 1 };
	});
	const postings = new Map<string, { i: number; x: number }[]>();
	vecs.forEach(({ v }, i) => {
		for (const [t, x] of v) {
			const list = postings.get(t) ?? [];
			list.push({ i, x });
			postings.set(t, list);
		}
	});
	const out = new Map<string, Candidate[]>();
	notes.forEach((note, i) => {
		const acc = new Map<number, number>();
		const shared = new Map<number, [number, string][]>();
		for (const [t, x] of vecs[i]!.v) {
			for (const { i: j, x: y } of postings.get(t)!) {
				if (j === i) continue;
				acc.set(j, (acc.get(j) ?? 0) + x * y);
				const list = shared.get(j) ?? [];
				list.push([x * y, t]);
				shared.set(j, list);
			}
		}
		const cands: Candidate[] = [];
		for (const [j, dot] of acc) {
			const other = notes[j]!;
			let factor = 1;
			if (note.doc && other.doc === note.doc && note.subject === other.subject) {
				if (note.ix !== null && other.ix !== null && Math.abs(note.ix - other.ix) <= 1) continue; // a direct neighbour: the prev / next links already join them
				factor = SAME_DOC_FACTOR;
			}
			const score = (dot / (vecs[i]!.norm * vecs[j]!.norm)) * factor;
			const toks = [...shared.get(j)!].sort((a, b) => b[0] - a[0] || -byCodePoint(a[1], b[1])).map(([, t]) => t);
			// one single term that both notes emphasise (title / key term / tag) is enough as well
			const strong = toks.filter((t) => note.weights.get(t)! >= 3 && other.weights.get(t)! >= 3);
			if (score >= MIN_SIM && (toks.length >= MIN_SHARED || strong.length > 0)) cands.push({ id: other.id, score, shared: toks.slice(0, 4) });
		}
		cands.sort((a, b) => b.score - a.score);
		out.set(note.id, cands);
	});
	return out;
}

export const reason = (shared: readonly string[]): string => `gemeinsame Begriffe: ${shared.slice(0, 3).join(", ")}`;

// ─── Claude checks the candidates ────────────────────────────────────────────

/** What one call of the check is given: the source notes of a batch with their best candidates. */
export function linkSources(batch: readonly VaultNote[], cands: ReadonlyMap<string, readonly Candidate[]>, byId: ReadonlyMap<string, VaultNote>) {
	return batch.map((note) => ({
		id: note.id,
		title: note.title,
		subject: note.subject,
		doc: note.doc,
		abstract: note.abstract,
		terms: note.terms.slice(0, 8),
		cands: cands.get(note.id)!.slice(0, CANDIDATES).map((c) => {
			const t = byId.get(c.id)!;
			return { id: c.id, title: t.title, subject: t.subject, doc: t.doc, terms: t.terms.slice(0, 5), score: c.score };
		}),
	}));
}

/** The model's answer → {source id: {target id: reason}}, only from the candidates that were offered. */
export function parseLinkPicks(raw: unknown, sources: readonly { id: string; cands: readonly { id: string }[] }[]): Map<string, Map<string, string>> {
	const allowed = new Map(sources.map((s) => [s.id, new Set(s.cands.map((c) => c.id))]));
	const picked = new Map<string, Map<string, string>>();
	const links = typeof raw === "object" && raw !== null ? (raw as { links?: unknown }).links : undefined;
	for (const entry of Array.isArray(links) ? links : []) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const e = entry as { id?: unknown; to?: unknown };
		const ok = typeof e.id === "string" ? allowed.get(e.id) : undefined;
		if (!ok) continue;
		for (const t of (Array.isArray(e.to) ? e.to : []).slice(0, PICK)) {
			if (typeof t !== "object" || t === null || Array.isArray(t)) continue;
			const target = t as { id?: unknown; why?: unknown };
			if (typeof target.id !== "string" || !ok.has(target.id)) continue;
			const why = target.why === null || target.why === undefined || target.why === "" || target.why === 0 || target.why === false ? "" : String(target.why);
			const map = picked.get(e.id as string) ?? new Map<string, string>();
			map.set(target.id, chars(why.split(/\s+/).filter(Boolean).join(" ")).slice(0, 90).join(""));
			picked.set(e.id as string, map);
		}
	}
	return picked;
}

/** The choice by similarity alone (no Claude, or the call failed): the best PICK candidates above the stricter bar. */
export function pickBySimilarity(batch: readonly VaultNote[], cands: ReadonlyMap<string, readonly Candidate[]>, picked: Picked): void {
	for (const note of batch) {
		for (const c of cands.get(note.id)!.slice(0, PICK)) {
			if (c.score >= MIN_SIM_NO_LLM) {
				const map = picked.get(note.id) ?? new Map<string, string>();
				map.set(c.id, reason(c.shared));
				picked.set(note.id, map);
			}
		}
	}
}

/** Claude's picks of one batch into the overall picks; an empty reason becomes the shared terms. */
export function addPicks(picked: Picked, res: ReadonlyMap<string, ReadonlyMap<string, string>>, cands: ReadonlyMap<string, readonly Candidate[]>): void {
	for (const [src, targets] of res) {
		if (targets.size === 0) continue;
		const map = picked.get(src) ?? new Map<string, string>();
		for (const [dst, why] of targets) map.set(dst, why || reason(cands.get(src)!.find((c) => c.id === dst)!.shared));
		picked.set(src, map);
	}
}

// ─── the links to write ──────────────────────────────────────────────────────

/** The final links per note: mutual (where the other side is the app's own note), at most MAX_LINKS. */
export function buildLinks(notes: readonly VaultNote[], cands: ReadonlyMap<string, readonly Candidate[]>, picked: Picked): Map<string, LinkRow[]> {
	const byId = new Map(notes.map((x) => [x.id, x]));
	const score = new Map<string, Candidate>();
	for (const [s, list] of cands) for (const c of list) score.set(`${s}\u0000${c.id}`, c);
	const links = new Map<string, Map<string, { why: string; score: number; chosen: boolean }>>();
	for (const [src, targets] of picked) {
		for (const [dst, why] of targets) {
			const c = score.get(`${src}\u0000${dst}`)!;
			const map = links.get(src) ?? new Map();
			map.set(dst, { why: why || reason(c.shared), score: c.score, chosen: true });
			links.set(src, map);
		}
	}
	for (const src of [...links.keys()]) {
		for (const [dst, info] of [...links.get(src)!]) {
			if (!byId.get(dst)!.owned) continue;
			const back = links.get(dst) ?? new Map();
			links.set(dst, back);
			if (!back.has(src)) back.set(src, { why: info.why, score: info.score, chosen: false }); // the way back (only where we may write)
		}
	}
	const out = new Map<string, LinkRow[]>();
	for (const [src, targets] of links) {
		if (!byId.get(src)!.owned) continue;
		const rows = [...targets].sort((a, b) => Number(!a[1].chosen) - Number(!b[1].chosen) || b[1].score - a[1].score).slice(0, MAX_LINKS);
		out.set(src, rows.map(([id, info]) => ({ id, why: info.why, score: info.score })));
	}
	return out;
}

/** The section "Verwandte Themen" of a note. */
export function blockBody(rows: readonly LinkRow[], byId: ReadonlyMap<string, VaultNote>): string {
	const lines = ["## Verwandte Themen"];
	for (const r of rows) {
		const t = byId.get(r.id)!;
		const where = t.subject || t.doc;
		lines.push(`- [[${t.rel}|${t.title}]]${where ? ` (${where})` : ""}${r.why ? ` – ${r.why}` : ""}`);
	}
	return lines.join("\n");
}

/** What a run came to (without the time). */
export function linkSummary(notes: readonly VaultNote[], links: ReadonlyMap<string, readonly LinkRow[]>, picked: Picked): Omit<LinkResult, "written" | "removed" | "llm" | "llmFailed" | "colors" | "at"> {
	const pairs = new Set<string>();
	const pair = (a: string, b: string) => pairs.add(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
	for (const [s, rows] of links) for (const r of rows) pair(s, r.id);
	for (const [s, ts] of picked) for (const t of ts.keys()) pair(s, t); // also the links to the reader's own notes
	const ids = new Set<string>();
	for (const p of pairs) for (const id of p.split("\u0000")) ids.add(id);
	return { notes: notes.length, own: notes.filter((x) => x.owned).length, linked: ids.size, links: pairs.size };
}
