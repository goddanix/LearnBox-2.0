/**
 * The study engine: the queue, the answer, the card faces (Learnbox 2.0, Slice 10c).
 *
 * PURE. It was the server's study service; it moved here so the very same code runs on the Mac (server/study.ts, the
 * desktop review screen) and on the phone (its own copy of the cards, offline). Everything it touches comes in
 * through `StudyEngineDeps`: the ledgers behind the `StudyStore` port and a media resolver (the Mac reads files,
 * the phone reads what it has downloaded).
 *
 * Stateless — every call re-derives the queue from the ledgers (core/study-queue.ts); the browser only carries a
 * `step` counter for the new/new/again pattern. Card HTML is rendered here (core/study-render.ts) with the media
 * inlined as data: URIs: the card lives in a sandboxed iframe, so it could not fetch them over HTTP anyway.
 */

import type { StudyCard, StudyCardView, StudyCourseSummary, StudyGrade, StudyNextResult } from "./contracts/study.ts";
import type { StudyStore } from "./ports.ts";
import { effectiveReviews } from "./fsrs.ts";
import {
	addDays,
	buildQueue,
	clockAt,
	courseOverviews,
	groupReviews,
	itemForCard,
	pickNext,
	previewIntervals,
	type CourseQueue,
	type QueueItem,
} from "./study-queue.ts";
import { renderFace, type MediaResolver } from "./study-render.ts";

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

export interface StudyEngineDeps {
	store: StudyStore;
	/** Media file name → a `data:` URI, or null when the file is missing (see core/study-render.ts). */
	resolve: MediaResolver;
}

/** Courses with their queue counts, for the "which course?" screen. */
export function studyCourses(now: Date, deps: StudyEngineDeps): StudyCourseSummary[] {
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

/** Cards of the same note (other than `card` itself): an Anki note, or the cards of one PDF / lesson
 *  draft (both directions, the gaps of one figure or sentence); a card without a shared note has none. */
function siblingsOf(card: StudyCard, cards: readonly StudyCard[]): StudyCard[] {
	const origin = card.origin;
	if (origin.kind === "anki-import") {
		return cards.filter((c) => c.id !== card.id && c.origin.kind === "anki-import" && c.origin.noteId === origin.noteId);
	}
	if ((origin.kind === "pdf" || origin.kind === "graph") && origin.jobId && origin.draftId) {
		return cards.filter((c) => c.id !== card.id && c.origin.kind === origin.kind && c.origin.jobId === origin.jobId && c.origin.draftId === origin.draftId);
	}
	return [];
}

function view(
	item: QueueItem,
	queue: CourseQueue,
	cards: readonly StudyCard[],
	now: Date,
	resolve: MediaResolver,
): StudyCardView {
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
		fields: item.card.fields,
		siblings: siblingsOf(item.card, cards).length,
		intervals: previewIntervals(item, queue, now),
	};
}

/**
 * The state of a course after a change: the queue's pick for `step`, or — when
 * `showCardId` is given (undo, edit, restore) — exactly that card.
 */
function nextResult(
	courseId: string,
	step: number,
	now: Date,
	deps: StudyEngineDeps,
	showCardId?: string,
): StudyNextResult {
	const course = deps.store.readCourses().find((c) => c.id === courseId);
	if (!course) throw new StudyInputError("Unknown course", 404);
	const cards = deps.store.readCards();
	const reviews = groupReviews(deps.store.readReviews());
	const queue = buildQueue(course, cards, reviews, clockAt(now));
	let item: QueueItem | null;
	if (showCardId === undefined) {
		item = pickNext(queue, step);
	} else {
		const card = cards.find((c) => c.id === showCardId && c.courseId === courseId && !c.suspended);
		item = card ? itemForCard(card, reviews, queue.fsrs) : null;
	}
	return {
		courseId,
		counts: queue.counts,
		step,
		card: item ? view(item, queue, cards, now, deps.resolve) : null,
	};
}

const cleanStep = (step: unknown): number =>
	typeof step === "number" ? Math.max(0, Math.trunc(step) || 0) : 0;

/**
 * The next card of a course; `step` 0 starts a session. `openCardId` opens that very card first
 * (a lesson links to the cards it came from, Slice 9) — a card that is gone, suspended or of
 * another course falls back to the queue's pick, so a stale link never reads as "done for today".
 */
export function studyNext(
	courseId: string,
	step: number,
	now: Date,
	deps: StudyEngineDeps,
	openCardId?: string,
): StudyNextResult {
	if (openCardId) {
		const open = deps.store.readCards().some((c) => c.id === openCardId && c.courseId === courseId && !c.suspended);
		if (open) return nextResult(courseId, cleanStep(step), now, deps, openCardId);
	}
	return nextResult(courseId, cleanStep(step), now, deps);
}

/** Record one answer and return the card after it (`step` is the answered card's step). */
export function studyAnswer(
	input: { courseId: string; cardId: string; grade: number; ms?: number; step?: number },
	now: Date,
	deps: StudyEngineDeps,
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
	return nextResult(courseId, cleanStep(input.step) + 1, now, deps);
}

/**
 * Take back the latest review of a card: appends a compensating line (the
 * ledger is never rewritten) and shows the card again at the step it was
 * answered in.
 */
export function studyUndo(
	input: { courseId: string; cardId: string; step?: number },
	now: Date,
	deps: StudyEngineDeps,
): StudyNextResult {
	const { courseId, cardId } = input;
	const card = deps.store.readCards().find((c) => c.id === cardId && c.courseId === courseId);
	if (!card) throw new StudyInputError("Unknown card", 404);
	const own = deps.store.readReviews().filter((r) => r.cardId === cardId);
	const last = effectiveReviews(own).at(-1);
	if (!last) throw new StudyInputError("Nothing to undo", 400);
	// never earlier than the review it cancels (clock skew would reorder the pair)
	const at = new Date(Math.max(now.getTime(), Date.parse(last.at) + 1)).toISOString();
	deps.store.appendReview({ cardId, at, grade: last.grade, undo: true });
	return nextResult(courseId, cleanStep(input.step), now, deps, cardId);
}

/** Largest edited field (characters): a card is text, not a document store. */
const MAX_FIELD_CHARS = 200_000;

export type StudyCardAction = "suspend" | "unsuspend" | "bury" | "unbury" | "edit";

/**
 * Change a card outside of answering it. suspend/bury (and their takebacks)
 * touch that card only — the step stays; `edit` rewrites the named fields on
 * the card and on every other card of the same Anki note.
 */
export function studyCardAction(
	input: {
		courseId: string;
		cardId: string;
		action: StudyCardAction;
		fields?: Record<string, string>;
		step?: number;
	},
	now: Date,
	deps: StudyEngineDeps,
): StudyNextResult {
	const { courseId, cardId, action } = input;
	const step = cleanStep(input.step);
	const cards = deps.store.readCards();
	const card = cards.find((c) => c.id === cardId && c.courseId === courseId);
	if (!card) throw new StudyInputError("Unknown card", 404);

	switch (action) {
		case "suspend": {
			deps.store.upsertCard({ ...card, suspended: true });
			return nextResult(courseId, step, now, deps);
		}
		case "unsuspend": {
			const { suspended: _drop, ...rest } = card;
			deps.store.upsertCard(rest);
			return nextResult(courseId, step, now, deps, cardId);
		}
		case "bury": {
			// hidden for the rest of today's study day
			deps.store.upsertCard({ ...card, buriedUntil: addDays(clockAt(now).today, 1) });
			return nextResult(courseId, step, now, deps);
		}
		case "unbury": {
			const { buriedUntil: _drop, ...rest } = card;
			deps.store.upsertCard(rest);
			return nextResult(courseId, step, now, deps, cardId);
		}
		case "edit": {
			const edits = input.fields;
			if (typeof edits !== "object" || edits === null || Array.isArray(edits)) {
				throw new StudyInputError("fields must be an object", 400);
			}
			const names = Object.keys(edits);
			if (names.length === 0) throw new StudyInputError("Nothing to edit", 400);
			for (const name of names) {
				const value = edits[name];
				if (!(name in card.fields)) throw new StudyInputError(`Unknown field: ${name}`, 400);
				if (typeof value !== "string") throw new StudyInputError(`Field ${name} must be text`, 400);
				if (value.length > MAX_FIELD_CHARS) throw new StudyInputError(`Field ${name} is too long`, 400);
			}
			const changed = [card, ...siblingsOf(card, cards)].flatMap((c) => {
				const fields = { ...c.fields };
				let touched = false;
				for (const name of names) {
					if (name in fields && fields[name] !== edits[name]) {
						fields[name] = edits[name]!;
						touched = true;
					}
				}
				return touched ? [{ ...c, fields }] : [];
			});
			deps.store.upsertCards(changed);
			return nextResult(courseId, step, now, deps, cardId);
		}
		default:
			throw new StudyInputError("Unknown action", 400);
	}
}
