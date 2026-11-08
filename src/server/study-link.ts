/**
 * Study ↔ lesson links, the server side (Learnbox 2.0, 2026-11, Slice 9)
 *
 * The weak-spot list of a course and the `study-context` marker data a lesson starts with.
 * Everything is derived from the ledgers on each call (cards, reviews, courses) — a request
 * names a course and card ids, never card text. Cards the learner picked must belong to the
 * course; unknown ids are an error (a stale link must not silently start a different lesson).
 */

import type { StudyContextData, StudyLinkCard, StudyWeakSpots } from "../core/contracts/study-link.ts";
import { LESSON_CARDS_MAX } from "../core/contracts/study-link.ts";
import { buildQueue, clockAt, groupReviews } from "../core/study-queue.ts";
import { topicNameOf } from "../core/phone-deck.ts";
import { buildStudyContext, cleanSubdecks, lapsesOf, linkCard, weakSpots } from "../core/study-link.ts";
import { defaultStudyDeps, StudyInputError, type StudyDeps } from "./study.ts";

function requireCourse(courseId: string, deps: StudyDeps) {
	const course = deps.store.readCourses().find((c) => c.id === courseId);
	if (!course) throw new StudyInputError("Unknown course", 404);
	return course;
}

/** A course's weak spots: the cards it fails most. */
export function studyWeakSpots(courseId: string, now: Date = new Date(), deps: StudyDeps = defaultStudyDeps()): StudyWeakSpots {
	const course = requireCourse(courseId, deps);
	const today = clockAt(now).today;
	const cards = deps.store.readCards();
	const reviews = groupReviews(deps.store.readReviews());
	return { courseId, cards: weakSpots(course, cards, reviews, today) };
}

/** The ids as given: strings only, once each, in order. */
function cleanIds(ids: unknown): string[] {
	if (!Array.isArray(ids)) return [];
	const seen = new Set<string>();
	for (const id of ids) if (typeof id === "string" && id.length > 0) seen.add(id);
	return [...seen];
}

/** The cards `cardIds` of a course as the lessons see them (plain text, lapses); unknown ids are a 404. */
export function studyLinkCards(
	courseId: string,
	cardIds: unknown,
	now: Date = new Date(),
	deps: StudyDeps = defaultStudyDeps(),
): StudyLinkCard[] {
	const course = requireCourse(courseId, deps);
	const ids = cleanIds(cardIds);
	if (ids.length > LESSON_CARDS_MAX) throw new StudyInputError(`A lesson can start from at most ${LESSON_CARDS_MAX} cards`, 400);
	const today = clockAt(now).today;
	const cards = deps.store.readCards();
	const reviews = groupReviews(deps.store.readReviews());
	return ids.map((id) => {
		const card = cards.find((c) => c.id === id && c.courseId === course.id);
		if (!card) throw new StudyInputError("Unknown card", 404);
		return linkCard(card, lapsesOf(course, card, reviews.get(card.id), today));
	});
}

/**
 * The marker data for a lesson for `courseId`, optionally from the cards `cardIds`: the course
 * (name, topics, exam day), its state today, its weak spots, and the picked cards' text. With `topics` the lesson
 * is limited to those subdecks (a phone that holds the course in part): the state and the weak spots come from their
 * cards only, and the marker says which subdecks they are.
 */
export function studyContextFor(
	input: { courseId: string; cardIds?: unknown; topics?: unknown },
	now: Date = new Date(),
	deps: StudyDeps = defaultStudyDeps(),
): StudyContextData {
	const course = requireCourse(input.courseId, deps);
	const picked = studyLinkCards(course.id, input.cardIds, now, deps);
	const clock = clockAt(now);
	const subdecks = cleanSubdecks(input.topics);
	const held = new Set(subdecks);
	const cards = deps.store.readCards().filter((c) => subdecks.length === 0 || c.courseId !== course.id || held.has(topicNameOf(c)));
	const reviews = groupReviews(deps.store.readReviews());
	const queue = buildQueue(course, cards, reviews, clock);
	return buildStudyContext({
		course,
		today: clock.today,
		due: queue.counts.learning + queue.counts.review,
		newToday: queue.counts.new,
		weakAll: weakSpots(course, cards, reviews, clock.today),
		picked,
		subdecks,
	});
}
