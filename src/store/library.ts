/**
 * LibraryStore — the fs adapter for the lecture library: one folder per
 * lecture in data/library/<id>/ holding source.pdf (the bytes, untouched) and
 * meta.json (the LectureSource record). Implements core/ports.ts LibraryStore.
 * Idioms follow the job store: sync fs, id-guarded paths, tab-indented JSON.
 * Record writes go through a temp file + rename so a crash never leaves a
 * half-written meta.json next to a good PDF.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { AddLectureInit, LibraryStore } from "../core/ports.ts";
import { LIBRARY_SCHEMA, LibraryError, MAX_LECTURE_BYTES, type LectureSource } from "../core/contracts.ts";

/** Lecture library (data/library). Not in config.ts PATHS, like data/jobs. */
const LIBRARY_DIR = path.join(PATHS.data, "library");
const PDF_MAGIC = "%PDF-";

function sourceDir(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid lecture id: ${id}`);
	return path.join(LIBRARY_DIR, id);
}

const pdfFile = (id: string) => path.join(sourceDir(id), "source.pdf");
const metaFile = (id: string) => path.join(sourceDir(id), "meta.json");

function writeMeta(source: LectureSource): void {
	const file = metaFile(source.id);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(source, null, "\t"), "utf-8");
	fs.renameSync(tmp, file);
}

/** "Lecture_03-Membranes.pdf" → "Lecture 03-Membranes". */
function titleFromFileName(fileName: string): string {
	const base = fileName.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim();
	return base || "Untitled lecture";
}

function readSource(id: string): LectureSource | null {
	try {
		const record = JSON.parse(fs.readFileSync(metaFile(id), "utf-8")) as LectureSource;
		// A newer stamp is refused, never half-understood (schema-stamp law).
		if (record.v !== LIBRARY_SCHEMA) return null;
		return record;
	} catch {
		return null;
	}
}

function list(): LectureSource[] {
	let ids: string[];
	try {
		ids = fs.readdirSync(LIBRARY_DIR);
	} catch {
		return [];
	}
	const sources: LectureSource[] = [];
	for (const id of ids) {
		if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
		const source = readSource(id);
		if (source) sources.push(source);
	}
	return sources.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

function add(init: AddLectureInit): { source: LectureSource; duplicate: boolean } {
	const { data } = init;
	if (data.byteLength === 0) throw new LibraryError("empty", "The file is empty.");
	if (data.byteLength > MAX_LECTURE_BYTES) {
		throw new LibraryError("too_large", `The PDF is larger than ${MAX_LECTURE_BYTES / (1024 * 1024)} MB.`);
	}
	if (Buffer.from(data.subarray(0, PDF_MAGIC.length)).toString("latin1") !== PDF_MAGIC) {
		throw new LibraryError("not_pdf", "Only PDF files can be added to the library.");
	}

	const sha256 = crypto.createHash("sha256").update(data).digest("hex");
	const existing = list().find((s) => s.sha256 === sha256);
	if (existing) return { source: existing, duplicate: true };

	// Never a path: only the base name survives, capped.
	const fileName = path.basename(init.fileName).slice(0, 200) || "lecture.pdf";
	const source: LectureSource = {
		v: LIBRARY_SCHEMA,
		id: `lec_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: titleFromFileName(fileName),
		fileName,
		bytes: data.byteLength,
		sha256,
		pages: null,
		addedAt: new Date().toISOString(),
		status: "stored",
	};
	fs.mkdirSync(sourceDir(source.id), { recursive: true });
	fs.writeFileSync(pdfFile(source.id), data);
	writeMeta(source);
	return { source, duplicate: false };
}

function update(id: string, patch: Parameters<LibraryStore["update"]>[1]): LectureSource | null {
	const current = readSource(id);
	if (!current) return null;
	const next: LectureSource = { ...current, ...patch };
	// An explicit undefined in the patch REMOVES the field (a finished run
	// clears its progress and any earlier error) — spreading alone would keep it.
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
	}
	writeMeta(next);
	return next;
}

function pdfPath(id: string): string | null {
	const file = pdfFile(id);
	return fs.existsSync(file) ? file : null;
}

function remove(id: string): boolean {
	const dir = sourceDir(id);
	if (!fs.existsSync(dir)) return false;
	fs.rmSync(dir, { recursive: true, force: true });
	return true;
}

export const libraryStore: LibraryStore = {
	add,
	get: readSource,
	list,
	update,
	pdfPath,
	remove,
};
