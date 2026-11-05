/**
 * The Obsidian vault as files (Learnbox 2.0, 2026-11): the fs half of MedAnki's vault.py and linker.py. A vault is
 * a folder of Markdown files, so notes are written directly (no Obsidian plugin or API needed). What a note must
 * look like and how an existing one is protected is core/vault-text.ts; which notes are alike and how they link is
 * core/vault-link.ts; here: reading the folder, copying the PDFs and figures, writing the files.
 *
 * Every function takes the vault's folder. They are synchronous on purpose: a save and a linking run therefore never
 * write at the same time (no lock needed in one process), and a linking run reads each note again right before it
 * writes, so edits made in Obsidian in the meantime are not lost.
 *
 * A text file is read as Python's `read_text` does: UTF-8 or not at all (a file that is not valid UTF-8 is left
 * alone, never rewritten), line ends as "\n". Only notes with a `medanki_id` are ever changed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { blockBody, type LinkRow, type VaultNote, parseNote } from "../core/vault-link.ts";
import {
	ASSETS,
	byCodePoint,
	byPathParts,
	frontmatterId,
	graphColorsFile,
	indexBody,
	indexText,
	INDEX_NAME,
	manageNote,
	MOC_NAME,
	removeLinksBlock,
	safeName,
	SAVE_DIR,
	setLinksBlock,
	slug,
	stripLegacyMarkers,
	topicFrontmatter,
} from "../core/vault-text.ts";

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A text file as Python's `Path.read_text(encoding="utf-8")` gives it: null when unreadable or not UTF-8. */
export function readText(file: string): string | null {
	try {
		return UTF8.decode(fs.readFileSync(file)).replace(/\r\n?/g, "\n");
	} catch {
		return null;
	}
}

/** The first `chars` characters of a text file (enough for the frontmatter); null when unreadable. */
function readHead(file: string, chars = 2000): string | null {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(chars * 4);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf.subarray(0, n)).replace(/\r\n?/g, "\n");
		return [...text].slice(0, chars).join("");
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** Every Markdown file under `root`, as paths relative to it ("a/b.md"), in Python's order of paths. Folders that are links are not entered. */
export function listMarkdown(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, rel: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(path.join(dir, e.name), r);
			else if ((e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".md") && e.name.length > 3) out.push(r);
		}
	};
	walk(root, "");
	return out.sort(byPathParts);
}

const isHidden = (rel: string): boolean => rel.split("/").some((p) => p.startsWith("."));
const baseName = (rel: string): string => rel.slice(rel.lastIndexOf("/") + 1);

/** Python's `Path.stem` / `Path.suffix` of a file name. */
function splitExt(name: string): [string, string] {
	const i = name.lastIndexOf(".");
	return i <= 0 || i === name.length - 1 ? [name, ""] : [name.slice(0, i), name.slice(i)];
}

/** `name (suffix).ext`, then `name (suffix 2).ext` … : the first that does not exist yet. */
function unique(file: string, suffix: string): string {
	if (!fs.existsSync(file)) return file;
	const dir = path.dirname(file);
	const [stem, ext] = splitExt(path.basename(file));
	let cand = path.join(dir, `${stem} (${suffix})${ext}`);
	let n = 2;
	while (fs.existsSync(cand)) cand = path.join(dir, `${stem} (${suffix} ${n++})${ext}`);
	return cand;
}

const APP_JSON = '{\n "attachmentFolderPath": "Files",\n "alwaysUpdateLinks": true,\n "promptDelete": false,\n "readableLineLength": true\n}\n';

/** Creates the vault folder with Obsidian's basic settings (where they are missing). */
export function ensureVault(root: string): void {
	fs.mkdirSync(path.join(root, ASSETS), { recursive: true });
	const cfg = path.join(root, ".obsidian");
	fs.mkdirSync(cfg, { recursive: true });
	const app = path.join(cfg, "app.json");
	if (!fs.existsSync(app)) fs.writeFileSync(app, APP_JSON, "utf8");
}

/** The course folders the vault has (top level; not hidden, not the attachments). */
export function listCourseFolders(root: string): string[] {
	try {
		return fs
			.readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== ASSETS)
			.map((d) => d.name)
			.sort(byCodePoint);
	} catch {
		return [];
	}
}

/** The notes by their `medanki_id`: id → path relative to the vault (the first of two with one id). */
function idIndex(root: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const rel of listMarkdown(root)) {
		if (rel.split("/").includes(".obsidian")) continue;
		const head = readHead(path.join(root, rel));
		const id = head === null ? null : frontmatterId(head);
		if (id !== null && !out.has(id)) out.set(id, rel);
	}
	return out;
}

/** The note of a given `medanki_id` (path relative to the vault), or null. */
export function findNoteById(root: string, id: string): string | null {
	return idIndex(root).get(id) ?? null;
}

// ─── saving topic notes ──────────────────────────────────────────────────────

/** Copies to `dest`; the same name with different content (size) gets an extra "(2)". Returns the file used. */
function copyIfNeeded(src: string, dest: string): string {
	if (fs.existsSync(dest)) {
		if (fs.statSync(dest).size === fs.statSync(src).size) return dest;
		dest = unique(dest, "2");
	}
	fs.copyFileSync(src, dest);
	return dest;
}

export interface TopicToSave {
	/** The note's id in the frontmatter (stays when the note is written again). */
	mid: string;
	title: string;
	markdown: string;
	cards: number;
	tags: string[];
}

export interface SaveTopicsInput {
	subject: string;
	courseId: string;
	topics: TopicToSave[];
	/** The PDFs the notes link to, as files to copy and the names they get in the vault. */
	pdfs: { src: string; name: string }[];
	figs: { src: string; name: string }[];
	/** The PDFs' names in order (for the sources of the overview). */
	pdfSources: string[];
	created: string;
}

export interface SaveTopicsResult {
	/** Absolute path of the overview note. */
	moc: string;
	mocCreated: boolean;
	notes: { mid: string; path: string; created: boolean; skipped: boolean }[];
	/** PDFs that got another name because the vault has a different file of that name. */
	renamed: Record<string, string>;
}

const relNoExt = (rel: string): string => rel.replace(/\.md$/, "");

/** Writes the notes of a course: `<course>/Themen/<topic>.md` each, the overview `00 Übersicht`, the PDFs and figures under `Files/<course>/`. */
export function saveTopicNotes(root: string, input: SaveTopicsInput): SaveTopicsResult {
	ensureVault(root);
	const subj = safeName(input.subject, "Fach");
	const assets = path.join(root, ASSETS, subj);
	fs.mkdirSync(assets, { recursive: true });
	const renamed: Record<string, string> = {};
	for (const { src, name } of input.pdfs) {
		const dest = copyIfNeeded(src, path.join(assets, name)); // the PDFs first: on a name clash the copy gets an extra
		if (path.basename(dest) !== name) renamed[name] = path.basename(dest);
	}
	for (const { src, name } of input.figs) copyIfNeeded(src, path.join(assets, name));

	const index = idIndex(root);
	const mocId = `${input.courseId}-moc`;
	const mocFound = index.get(mocId);
	const folder = mocFound ? path.join(root, path.dirname(mocFound)) : path.join(root, subj, SAVE_DIR);
	const mocPath = mocFound ? path.join(root, mocFound) : unique(path.join(folder, `${MOC_NAME}.md`), "MedAnki");
	const rel = (abs: string): string => relNoExt(path.relative(root, abs).split(path.sep).join("/"));
	const mocRel = rel(mocPath);
	const pdfNames = input.pdfSources.map((n) => renamed[n] ?? n);

	const write = (file: string, note: { title: string; body: string; front: string }): "created" | "updated" | "skipped" => {
		const existing = fs.existsSync(file) ? readText(file) : null;
		if (fs.existsSync(file) && existing === null) return "skipped"; // not readable as text: left alone
		const res = manageNote(existing, note);
		if (res.text !== null && res.changed) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, res.text, "utf8");
		}
		return res.state;
	};

	const taken = new Set([mocPath]);
	const results: SaveTopicsResult["notes"] = [];
	for (const t of input.topics) {
		let md = t.markdown;
		for (const [from, to] of Object.entries(renamed)) md = md.split(`[[${from}#`).join(`[[${to}#`);
		const found = index.get(t.mid);
		let p: string;
		if (found) p = path.join(root, found);
		else {
			p = unique(path.join(folder, `${safeName(t.title, "Thema")}.md`), "MedAnki");
			while (taken.has(p)) {
				const [stem] = splitExt(path.basename(p));
				p = unique(path.join(path.dirname(p), `${stem} x.md`), "MedAnki"); // two equal titles in one run
			}
		}
		taken.add(p);
		const front = topicFrontmatter({ subject: subj, topic: t.title, id: t.mid, created: input.created, tags: t.tags, sources: pdfNames.filter((n) => md.includes(`[[${n}#`)) });
		const body = `[[${mocRel}|↑ ${subj} · Themen]]\n\n${md.trim()}`;
		const state = write(p, { title: safeName(t.title, "Thema"), body, front });
		if (!index.has(t.mid)) index.set(t.mid, path.relative(root, p).split(path.sep).join("/"));
		results.push({ mid: t.mid, path: p, created: state === "created", skipped: state === "skipped" });
	}

	const lines = [`**Fach:** ${subj} · ${results.length} Themen`, "", "## Themen"];
	input.topics.forEach((t, i) => lines.push(`- [[${rel(results[i]!.path)}|${t.title}]] · ${t.cards} Karten`));
	lines.push("", "## Quellen", ...pdfNames.map((n) => `- [[${n}]]`));
	const mocFront = topicFrontmatter({ subject: subj, id: mocId, created: input.created, tags: ["medizinstudium", slug(subj).toLowerCase()], sources: pdfNames, moc: true });
	const mocState = write(mocPath, { title: `${subj} – Themen`, body: lines.join("\n"), front: mocFront });
	rebuildIndex(root);
	return { moc: mocPath, mocCreated: mocState === "created", notes: results, renamed };
}

/** `Übersicht.md` at the root: every overview note the app wrote, by course (the generated part only; the rest is the reader's). */
export function rebuildIndex(root: string): void {
	const entries = new Map<string, { rel: string; name: string }[]>();
	for (const rel of listMarkdown(root)) {
		if (rel.split("/").includes(".obsidian") || baseName(rel) === INDEX_NAME) continue;
		const head = readHead(path.join(root, rel));
		if (head === null || !frontmatterId(head) || !head.includes("medanki_moc: true")) continue;
		const parts = relNoExt(rel).split("/");
		const subject = parts.length > 2 ? parts[0]! : "Allgemein";
		const list = entries.get(subject) ?? [];
		list.push({ rel: relNoExt(rel), name: splitExt(baseName(rel))[0] });
		entries.set(subject, list);
	}
	const file = path.join(root, INDEX_NAME);
	const existing = fs.existsSync(file) ? readText(file) : null;
	if (fs.existsSync(file) && existing === null) return;
	const text = indexText(existing, indexBody(entries));
	if (text !== null) fs.writeFileSync(file, text, "utf8");
}

/** Takes the earlier visible `%% medanki:… %%` markers out of every file the app wrote. Returns the files changed. */
export function migrateVault(root: string): number {
	let n = 0;
	for (const rel of listMarkdown(root)) {
		if (isHidden(rel)) continue;
		const file = path.join(root, rel);
		const text = readText(file);
		if (text === null || !text.includes("%% medanki:")) continue;
		if (!(baseName(rel) === INDEX_NAME || frontmatterId(text.slice(0, 2000)))) continue;
		const clean = stripLegacyMarkers(text);
		if (clean !== text) {
			fs.writeFileSync(file, clean, "utf8");
			n++;
		}
	}
	return n;
}

// ─── linking ─────────────────────────────────────────────────────────────────

/** The notes of the vault the way the linker reads them (overview notes and `Übersicht.md` are left out). */
export function scanNotes(root: string): VaultNote[] {
	const notes: VaultNote[] = [];
	for (const rel of listMarkdown(root)) {
		if (isHidden(rel) || baseName(rel) === INDEX_NAME) continue;
		const text = readText(path.join(root, rel));
		if (text === null) continue;
		const note = parseNote(text, rel, notes.length + 1);
		if (note) notes.push(note);
	}
	return notes;
}

/** Writes the section "Verwandte Themen" into the app's own notes (and takes outdated ones out). */
export function applyLinks(root: string, notes: readonly VaultNote[], links: ReadonlyMap<string, readonly LinkRow[]>): { written: number; removed: number } {
	const byId = new Map(notes.map((n) => [n.id, n]));
	let written = 0;
	let removed = 0;
	for (const n of notes) {
		if (!n.owned) continue;
		const file = path.join(root, n.file);
		const text = readText(file);
		if (text === null) continue;
		const rows = links.get(n.id);
		const next = rows && rows.length > 0 ? setLinksBlock(text, blockBody(rows, byId)) : removeLinksBlock(text); // also clears old markers
		if (next !== text) {
			fs.writeFileSync(file, next, "utf8");
			if (rows && rows.length > 0) written++;
			else removed++;
		}
	}
	return { written, removed };
}

/** Takes every "Verwandte Themen" section out of the app's own notes. Returns how many notes had one. */
export function unlinkVault(root: string): number {
	let n = 0;
	for (const note of scanNotes(root)) {
		if (!note.owned) continue;
		const clean = stripLegacyMarkers(note.text);
		const next = removeLinksBlock(clean);
		if (next !== note.text) fs.writeFileSync(path.join(root, note.file), next, "utf8");
		if (next !== clean) n++; // only notes that had links count
	}
	return n;
}

/** Colour groups per course for Obsidian's graph (only if the reader has none). Returns whether the file was written. */
export function writeGraphColors(root: string, subjects: readonly string[]): boolean {
	const file = path.join(root, ".obsidian", "graph.json");
	let existing: string | null = null;
	if (fs.existsSync(file)) {
		existing = readText(file);
		if (existing === null) return false;
	}
	const out = graphColorsFile(existing, subjects);
	if (out === null) return false;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, out, "utf8");
	return true;
}
