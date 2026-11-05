/**
 * MedAnki's subjects, topic notes, audio summary and settings in Learnbox's shapes (Learnbox 2.0, 2026-11, Slice 8). Pure: what
 * MedAnki stored (data/settings.json, data/courses/<id>/themen_notizen.json and audio/audio.json) arrives as untrusted JSON.
 * The folder reading is server/create-migrate.ts; the PDF jobs are core/legacy-cards.ts.
 *
 * A MedAnki subject ("Fach") becomes a Learnbox course with the SAME id, and that id is also its vault key: the notes MedAnki
 * wrote into the Obsidian vault carry `medanki_id: <subject id>-<topic>`, so a re-save updates them instead of writing twice.
 */

import { cleanTopics } from "./card-util.ts";
import type { AudioDoc, AudioStatus } from "./contracts/create-audio.ts";
import type { LinkResult, NoteFigure, NoteSource, NotesDoc, NotesStatus, SavedNotes, TopicNote } from "./contracts/create-notes.ts";
import type { StudyCourse } from "./contracts/study.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const count = (v: unknown): number => {
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
	return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
};

/** The id of a Learnbox job made from a MedAnki job (both kinds of MedAnki job use it, so a second import finds what is there). */
export const legacyJobId = (id: string): string => `crt_legacy_${id}`;

const ID = /^[A-Za-z0-9_-]+$/;

// ─── subjects ─────────────────────────────────────────────────────────────────

export interface LegacyCourse {
	id: string;
	name: string;
	topics: string[];
	strict: boolean;
}

/** The subjects in MedAnki's data/settings.json. */
export function legacyCourses(settings: unknown): LegacyCourse[] {
	if (!isRecord(settings) || !Array.isArray(settings.courses)) return [];
	const out: LegacyCourse[] = [];
	for (const c of settings.courses) {
		if (!isRecord(c)) continue;
		const id = text(c.id).trim();
		const name = text(c.name).replace(/\s+/g, " ").trim();
		if (!ID.test(id) || !name || out.some((o) => o.id === id)) continue;
		const topics = cleanTopics(c.topics);
		out.push({ id, name: name.slice(0, 80), topics, strict: c.strict === true && topics.length > 0 });
	}
	return out;
}

/** The course a subject becomes (no deadline: the learner sets one if the subject has an exam). */
export function legacyCourseRecord(c: LegacyCourse, name: string, at: string): StudyCourse {
	return { id: c.id, name, bufferDays: 5, ...(c.topics.length > 0 ? { topics: c.topics } : {}), ...(c.strict ? { strictTopics: true } : {}), vaultKey: c.id, createdAt: at };
}

/** The vault folder MedAnki wrote to (absolute path), if its settings name one. */
export function legacyVaultPath(settings: unknown): string | null {
	const p = isRecord(settings) ? text(settings.vault_path).trim() : "";
	return p.startsWith("/") ? p : null;
}

export function legacyVoice(settings: unknown): string | null {
	const v = isRecord(settings) ? text(settings.elevenlabs_voice_id).trim() : "";
	return /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
}

/** The last result of "link the vault" (MedAnki `link_result`, snake_case). */
export function legacyLinkResult(settings: unknown): LinkResult | null {
	const r = isRecord(settings) && isRecord(settings.link_result) ? settings.link_result : null;
	if (!r || typeof r.at !== "string") return null;
	return {
		notes: count(r.notes),
		own: count(r.own),
		linked: count(r.linked),
		links: count(r.links),
		written: count(r.written),
		removed: count(r.removed),
		llm: r.llm === true,
		llmFailed: count(r.llm_failed),
		colors: r.colors === true,
		at: r.at,
	};
}

// ─── topic notes ──────────────────────────────────────────────────────────────

/** Where MedAnki kept a subject's note figures (relative to data/courses/<id>/), and where Learnbox keeps them (relative to data/notes/<id>/) — the same `figs/<file>`. */
export const LEGACY_FIGS = "figs";

function legacyFigure(v: unknown): NoteFigure | null {
	if (!isRecord(v) || !text(v.id) || !text(v.file)) return null;
	return { id: text(v.id), file: text(v.file), src: text(v.src) || `${LEGACY_FIGS}/${text(v.file)}`, page: count(v.page), ref: text(v.ref), caption: text(v.caption) };
}

const NOTE_KINDS = ["pending", "note", "skipped", "error"] as const;

function legacyNote(v: unknown, i: number): TopicNote | null {
	if (!isRecord(v) || !text(v.topic)) return null;
	const kind = (NOTE_KINDS as readonly unknown[]).includes(v.kind) ? (v.kind as TopicNote["kind"]) : "pending";
	return {
		id: text(v.id) || `t${String(i + 1).padStart(2, "0")}`,
		ix: count(v.ix) || i + 1,
		topic: text(v.topic),
		kind,
		skipReason: text(v.skip_reason),
		cards: count(v.cards),
		pages: count(v.pages),
		refs: strings(v.refs),
		markdown: text(v.markdown),
		words: count(v.words),
		figures: Array.isArray(v.figures) ? v.figures.map(legacyFigure).filter((f): f is NoteFigure => f !== null) : [],
		...(Array.isArray(v.tags) ? { tags: strings(v.tags) } : {}),
		include: v.include !== false,
		error: text(v.error),
	};
}

/** The date MedAnki stamped a save with ("2026-10-20") is kept as it was. */
function legacySaved(v: unknown): SavedNotes | null {
	if (!isRecord(v) || !text(v.path)) return null;
	return {
		path: text(v.path),
		url: text(v.url),
		created: v.created === true,
		vault: text(v.vault),
		count: count(v.count),
		...(count(v.skipped) > 0 ? { skipped: count(v.skipped) } : {}),
		at: text(v.at),
	};
}

/** A subject's note set (`themen_notizen.json`); `jobIds` turns MedAnki's job ids into Learnbox's. Null when it holds no notes. */
export function legacyNotes(raw: unknown, jobIds: (legacyId: string) => string): NotesDoc | null {
	if (!isRecord(raw) || !Array.isArray(raw.items)) return null;
	const items = raw.items.map(legacyNote).filter((n): n is TopicNote => n !== null);
	if (items.length === 0) return null;
	const sources: NoteSource[] = Array.isArray(raw.sources)
		? raw.sources.flatMap((s): NoteSource[] =>
				isRecord(s) && text(s.ref) && text(s.job_id)
					? [{ ref: text(s.ref), jobId: jobIds(text(s.job_id)), name: text(s.name), pdfFile: text(s.pdf_file) }]
					: [],
			)
		: [];
	// a note set that was being written when MedAnki stopped counts as finished with what it has
	const status: NotesStatus = raw.status === "error" ? "error" : "done";
	return { status, error: text(raw.error), name: text(raw.name), created: text(raw.created), sources, items, saved: legacySaved(raw.saved) };
}

/** The files a note set's figures need (names relative to MedAnki's data/courses/<id>/figs/), without anything outside that folder. */
export function legacyFigureFiles(doc: NotesDoc): string[] {
	const names = new Set<string>();
	for (const n of doc.items) for (const f of n.figures) if (/^[\w.\- ]+$/.test(f.file) && !f.file.includes("..")) names.add(f.file);
	return [...names];
}

// ─── audio summary ────────────────────────────────────────────────────────────

/** MedAnki's audio/audio.json → the summary (null: nothing to carry over). `audioAt` is when the MP3 was made — the caller knows it from the file. */
export function legacyAudio(raw: unknown, jobIds: (legacyId: string) => string, audio: { file: string | null; at: string }): AudioDoc | null {
	if (!isRecord(raw) || !text(raw.script).trim()) return null;
	const status: AudioStatus = raw.status === "error" ? "error" : "draft";
	return {
		status,
		title: text(raw.title),
		script: text(raw.script),
		file: audio.file,
		audioAt: audio.file ? audio.at : "",
		error: text(raw.error),
		audioError: "",
		jobIds: strings(raw.job_ids).map(jobIds),
	};
}
