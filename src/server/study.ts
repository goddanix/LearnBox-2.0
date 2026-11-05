/**
 * The review screen's server side: the study engine (core/study-engine.ts, shared with the phone) plugged into
 * the ledgers on disk and the media folder. The media files are inlined as data: URIs: the desktop shell authorises
 * /api requests of the main frame only, and the card lives in a sandboxed iframe, so it could not fetch them over
 * HTTP anyway.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { StudyCourse, StudyCourseSummary, StudyNextResult } from "../core/contracts/study.ts";
import type { StudyStore } from "../core/ports.ts";
import { courseSlug } from "../core/anki-import.ts";
import {
	StudyInputError,
	studyAnswer as engineAnswer,
	studyCardAction as engineCardAction,
	studyCourses as engineCourses,
	studyNext as engineNext,
	studyUndo as engineUndo,
	type StudyCardAction,
	type StudyEngineDeps,
} from "../core/study-engine.ts";
import type { MediaResolver } from "../core/study-render.ts";
import { studyStore } from "../store/study.ts";

export { StudyInputError };
export type { StudyCardAction };

export interface StudyDeps {
	store: StudyStore;
	mediaDir: string;
}

const defaultDeps = (): StudyDeps => ({ store: studyStore, mediaDir: PATHS.studyMedia });
export const defaultStudyDeps = defaultDeps;

const MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".m4a": "audio/mp4",
};
/** Larger files are not inlined (they would bloat every card response). */
const MAX_INLINE_BYTES = 12 * 1024 * 1024;

/** Where a card's media file is, its type and size; null when the name is unsafe, the type unknown, the file missing or too big. */
export function mediaFile(mediaDir: string, name: string): { file: string; mime: string; size: number } | null {
	// a bare file name only — no folders, no dot files
	if (name.length === 0 || name !== path.basename(name) || name.startsWith(".")) return null;
	const mime = MIME[path.extname(name).toLowerCase()];
	if (!mime) return null;
	try {
		const file = path.join(mediaDir, name);
		const size = fs.statSync(file).size;
		return size > MAX_INLINE_BYTES ? null : { file, mime, size };
	} catch {
		return null;
	}
}

/** Reads `name` from the media folder as a data: URI; null when missing, unsafe or too big. */
export function mediaResolver(mediaDir: string): MediaResolver {
	return (name) => {
		const found = mediaFile(mediaDir, name);
		if (!found) return null;
		try {
			return `data:${found.mime};base64,${fs.readFileSync(found.file).toString("base64")}`;
		} catch {
			return null;
		}
	};
}

/** Add a course (Fach) by name; its id is the name's slug. A name that is taken, or a
 *  date that is not a real calendar day, is refused. */
export function createStudyCourse(
	input: { name?: unknown; deadline?: unknown; bufferDays?: unknown },
	now: Date = new Date(),
	deps: StudyDeps = defaultDeps(),
): StudyCourse {
	const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
	if (name.length === 0 || name.length > 80) throw new StudyInputError("A course needs a name of 1-80 characters", 400);
	let deadline: string | undefined;
	if (input.deadline !== undefined && input.deadline !== null && input.deadline !== "") {
		const day = typeof input.deadline === "string" ? input.deadline : "";
		const real = /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day);
		if (!real) throw new StudyInputError("The deadline must be a calendar date (YYYY-MM-DD)", 400);
		deadline = day;
	}
	const buffer = typeof input.bufferDays === "number" && Number.isFinite(input.bufferDays) ? Math.trunc(input.bufferDays) : 5;
	const id = courseSlug(name);
	if (deps.store.readCourses().some((c) => c.id === id || c.name.toLowerCase() === name.toLowerCase())) {
		throw new StudyInputError(`A course called "${name}" already exists`, 400);
	}
	const course: StudyCourse = {
		id,
		name,
		...(deadline ? { deadline } : {}),
		bufferDays: Math.min(60, Math.max(0, buffer)),
		createdAt: now.toISOString(),
	};
	deps.store.upsertCourse(course);
	return course;
}

const engine = (deps: StudyDeps): StudyEngineDeps => ({ store: deps.store, resolve: mediaResolver(deps.mediaDir) });

/** Courses with their queue counts, for the "which course?" screen. */
export function studyCourses(now: Date = new Date(), deps: StudyDeps = defaultDeps()): StudyCourseSummary[] {
	return engineCourses(now, engine(deps));
}

/**
 * The next card of a course; `step` 0 starts a session. `openCardId` opens that very card first
 * (a lesson links to the cards it came from, Slice 9) — a card that is gone, suspended or of
 * another course falls back to the queue's pick, so a stale link never reads as "done for today".
 */
export function studyNext(courseId: string, step = 0, now: Date = new Date(), deps: StudyDeps = defaultDeps(), openCardId?: string): StudyNextResult {
	return engineNext(courseId, step, now, engine(deps), openCardId);
}

/** Record one answer and return the card after it (`step` is the answered card's step). */
export function studyAnswer(
	input: { courseId: string; cardId: string; grade: number; ms?: number; step?: number },
	now: Date = new Date(),
	deps: StudyDeps = defaultDeps(),
): StudyNextResult {
	return engineAnswer(input, now, engine(deps));
}

/** Take back the latest review of a card (see core/study-engine.ts). */
export function studyUndo(input: { courseId: string; cardId: string; step?: number }, now: Date = new Date(), deps: StudyDeps = defaultDeps()): StudyNextResult {
	return engineUndo(input, now, engine(deps));
}

/** Change a card outside of answering it: suspend / bury / edit (see core/study-engine.ts). */
export function studyCardAction(
	input: { courseId: string; cardId: string; action: StudyCardAction; fields?: Record<string, string>; step?: number },
	now: Date = new Date(),
	deps: StudyDeps = defaultDeps(),
): StudyNextResult {
	return engineCardAction(input, now, engine(deps));
}
