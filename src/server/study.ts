/**
 * The review screen's server side: the queue, the answer, the card faces.
 *
 * Stateless — every call re-derives the queue from the ledgers
 * (core/study-queue.ts); the browser only carries a `step` counter for the
 * new/new/again pattern. Card HTML is rendered here (core/study-render.ts)
 * with the media files inlined as data: URIs: the desktop shell authorises
 * /api requests of the main frame only, and the card lives in a sandboxed
 * iframe, so it could not fetch them over HTTP anyway.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type {
	StudyCardView,
	StudyCourseSummary,
	StudyGrade,
	StudyNextResult,
} from "../core/contracts/study.ts";
import type { StudyStore } from "../core/ports.ts";
import {
	buildQueue,
	clockAt,
	courseOverviews,
	groupReviews,
	pickNext,
	previewIntervals,
	type CourseQueue,
	type QueueItem,
} from "../core/study-queue.ts";
import { renderFace, type MediaResolver } from "../core/study-render.ts";
import { studyStore } from "../store/study.ts";

/** A bad request (unknown course/card, bad grade); routes map it to 404/400. */
export class StudyInputError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404,
	) {
		super(message);
		this.name = "StudyInputError";
	}
}

export interface StudyDeps {
	store: StudyStore;
	mediaDir: string;
}

const defaultDeps = (): StudyDeps => ({ store: studyStore, mediaDir: PATHS.studyMedia });

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

/** Reads `name` from the media folder as a data: URI; null when missing, unsafe or too big. */
export function mediaResolver(mediaDir: string): MediaResolver {
	return (name) => {
		// a bare file name only — no folders, no dot files
		if (name.length === 0 || name !== path.basename(name) || name.startsWith(".")) return null;
		const mime = MIME[path.extname(name).toLowerCase()];
		if (!mime) return null;
		try {
			const file = path.join(mediaDir, name);
			if (fs.statSync(file).size > MAX_INLINE_BYTES) return null;
			return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
		} catch {
			return null;
		}
	};
}

/** Courses with their queue counts, for the "which course?" screen. */
export function studyCourses(now: Date = new Date(), deps: StudyDeps = defaultDeps()): StudyCourseSummary[] {
	const overviews = courseOverviews(
		deps.store.readCourses(),
		deps.store.readCards(),
		deps.store.readReviews(),
		clockAt(now),
	);
	return overviews.map((o) => ({
		id: o.course.id,
		name: o.course.name,
		deadline: o.course.deadline,
		daysLeft: o.daysLeft,
		total: o.total,
		counts: o.counts,
		newQuota: o.newQuota,
	}));
}

function view(item: QueueItem, queue: CourseQueue, now: Date, mediaDir: string): StudyCardView {
	const resolve = mediaResolver(mediaDir);
	const front = renderFace(item.card, "front", resolve);
	const back = renderFace(item.card, "back", resolve);
	return {
		id: item.card.id,
		kind: item.card.kind,
		bucket: item.bucket,
		core: item.card.core,
		topic: item.card.topic,
		front: front.html,
		back: back.html,
		split: front.split,
		intervals: previewIntervals(item, queue, now),
	};
}

function nextResult(
	courseId: string,
	step: number,
	now: Date,
	deps: StudyDeps,
): StudyNextResult {
	const course = deps.store.readCourses().find((c) => c.id === courseId);
	if (!course) throw new StudyInputError("Unknown course", 404);
	const queue = buildQueue(
		course,
		deps.store.readCards(),
		groupReviews(deps.store.readReviews()),
		clockAt(now),
	);
	const item = pickNext(queue, step);
	return {
		courseId,
		counts: queue.counts,
		step,
		card: item ? view(item, queue, now, deps.mediaDir) : null,
	};
}

/** The next card of a course; `step` 0 starts a session. */
export function studyNext(
	courseId: string,
	step = 0,
	now: Date = new Date(),
	deps: StudyDeps = defaultDeps(),
): StudyNextResult {
	return nextResult(courseId, Math.max(0, Math.trunc(step) || 0), now, deps);
}

/** Record one answer and return the card after it (`step` is the answered card's step). */
export function studyAnswer(
	input: { courseId: string; cardId: string; grade: number; ms?: number; step?: number },
	now: Date = new Date(),
	deps: StudyDeps = defaultDeps(),
): StudyNextResult {
	const { courseId, cardId } = input;
	if (![1, 2, 3, 4].includes(input.grade)) throw new StudyInputError("Grade must be 1-4", 400);
	const card = deps.store.readCards().find((c) => c.id === cardId && c.courseId === courseId);
	if (!card || card.suspended) throw new StudyInputError("Unknown card", 404);
	const ms =
		typeof input.ms === "number" && Number.isFinite(input.ms)
			? Math.min(Math.max(0, Math.round(input.ms)), 600_000)
			: undefined;
	deps.store.appendReview({
		cardId,
		at: now.toISOString(),
		grade: input.grade as StudyGrade,
		...(ms === undefined ? {} : { ms }),
	});
	const step = Math.max(0, Math.trunc(input.step ?? 0) || 0) + 1;
	return nextResult(courseId, step, now, deps);
}
