/**
 * The topic notes of a course as files (Learnbox 2.0, 2026-11): data/notes/<course>/notes.json (the note set:
 * sources, one item per topic, where it was saved) and data/notes/<course>/figs/ (the figures cut out of the PDFs
 * for the notes). MedAnki kept the same in data/courses/<id>/themen_notizen.json. Read-modify-write, written
 * through a temp file so a crash cannot leave half a note set. `createNotesStore(dir)` takes the folder so tests run
 * in a temp dir.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { NotesDoc } from "../core/contracts/create-notes.ts";

export interface NotesStore {
	read(courseId: string): NotesDoc | null;
	/** Read-modify-write (synchronous, so no other write interleaves); a course without a note set starts from an empty one. */
	update(courseId: string, change: (doc: NotesDoc) => void): NotesDoc;
	/** The folder of the cut-out figures, created on demand. */
	figsDir(courseId: string): string;
	/** Deletes the note set of a course (its figures too). */
	remove(courseId: string): void;
}

export const emptyNotesDoc = (): NotesDoc => ({ status: "none", error: "", name: "", created: "", sources: [], items: [], saved: null });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function courseDir(root: string, courseId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(courseId)) throw new Error("invalid course id");
	return path.join(root, courseId);
}

export function createNotesStore(root: string): NotesStore {
	const fileOf = (courseId: string) => path.join(courseDir(root, courseId), "notes.json");
	const read = (courseId: string): NotesDoc | null => {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(fileOf(courseId), "utf8"));
			if (!isRecord(parsed) || !Array.isArray(parsed.items) || !Array.isArray(parsed.sources)) return null;
			return { ...emptyNotesDoc(), ...(parsed as Partial<NotesDoc>) };
		} catch {
			return null;
		}
	};
	return {
		read,
		update(courseId, change) {
			const doc = read(courseId) ?? emptyNotesDoc();
			change(doc);
			const file = fileOf(courseId);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(doc, null, 1), "utf8");
			fs.renameSync(tmp, file);
			return doc;
		},
		figsDir(courseId) {
			const dir = path.join(courseDir(root, courseId), "figs");
			fs.mkdirSync(dir, { recursive: true });
			return dir;
		},
		remove(courseId) {
			fs.rmSync(courseDir(root, courseId), { recursive: true, force: true });
		},
	};
}

/** The live store (data/notes/*). */
export const notesStore: NotesStore = createNotesStore(PATHS.notes);
