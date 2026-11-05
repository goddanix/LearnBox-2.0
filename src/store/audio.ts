/**
 * The audio summary of a course as files (Learnbox 2.0, 2026-11): data/audio/<course>/audio.json (the script and where it
 * stands) and summary.mp3 beside it; data/audio/settings.json holds the voice. MedAnki kept the same in
 * data/courses/<id>/audio/. Read-modify-write, written through a temp file so a crash cannot leave half a document.
 * `createAudioStore(dir)` takes the folder so tests run in a temp dir.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { AudioDoc } from "../core/contracts/create-audio.ts";

export interface AudioStore {
	read(courseId: string): AudioDoc | null;
	/** Read-modify-write (synchronous, so no other write interleaves); a course without a summary starts from an empty one. */
	update(courseId: string, change: (doc: AudioDoc) => void): AudioDoc;
	/** Keep the MP3 of a course under `name`. */
	writeFile(courseId: string, name: string, data: Uint8Array): void;
	/** The path of a kept file (null: there is none by that name). */
	fileOf(courseId: string, name: string): string | null;
	removeFile(courseId: string, name: string): void;
	/** The voice chosen by the learner (null: none, the default is used). */
	voice(): string | null;
	setVoice(voiceId: string | null): void;
}

export const emptyAudioDoc = (): AudioDoc => ({ status: "none", title: "", script: "", file: null, audioAt: "", error: "", audioError: "", jobIds: [] });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SAFE = /^[A-Za-z0-9_-]+$/;
const SAFE_FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 1), "utf8");
	fs.renameSync(tmp, file);
}

export function createAudioStore(root: string): AudioStore {
	const dirOf = (courseId: string) => {
		if (!SAFE.test(courseId)) throw new Error("invalid course id");
		return path.join(root, courseId);
	};
	const fileName = (name: string) => {
		if (!SAFE_FILE.test(name) || name.includes("..")) throw new Error("invalid file name");
		return name;
	};
	const docFile = (courseId: string) => path.join(dirOf(courseId), "audio.json");
	const settingsFile = path.join(root, "settings.json");
	const read = (courseId: string): AudioDoc | null => {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(docFile(courseId), "utf8"));
			if (!isRecord(parsed)) return null;
			const doc = { ...emptyAudioDoc(), ...(parsed as Partial<AudioDoc>) };
			if (!Array.isArray(doc.jobIds)) doc.jobIds = [];
			return doc;
		} catch {
			return null;
		}
	};
	return {
		read,
		update(courseId, change) {
			const doc = read(courseId) ?? emptyAudioDoc();
			change(doc);
			writeJson(docFile(courseId), doc);
			return doc;
		},
		writeFile(courseId, name, data) {
			const file = path.join(dirOf(courseId), fileName(name));
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.tmp`;
			fs.writeFileSync(tmp, data);
			fs.renameSync(tmp, file);
		},
		fileOf(courseId, name) {
			const file = path.join(dirOf(courseId), fileName(name));
			return fs.existsSync(file) ? file : null;
		},
		removeFile(courseId, name) {
			fs.rmSync(path.join(dirOf(courseId), fileName(name)), { force: true });
		},
		voice() {
			try {
				const parsed: unknown = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
				const id = isRecord(parsed) && typeof parsed.voiceId === "string" ? parsed.voiceId.trim() : "";
				return id || null;
			} catch {
				return null;
			}
		},
		setVoice(voiceId) {
			writeJson(settingsFile, voiceId ? { voiceId } : {});
		},
	};
}

/** The live store (data/audio/*). */
export const audioStore: AudioStore = createAudioStore(PATHS.audio);
