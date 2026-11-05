/**
 * An in-memory StudyStore (Learnbox 2.0, Slice 10c): the same last-wins ledgers as the fs adapter, in memory. The
 * phone keeps its copy of the cards here while it studies (the study engine is synchronous; IndexedDB is not), and
 * tests use it for the engine. `onChange` hears every write, so a persistence layer can follow along.
 */

import type { StudyCard, StudyCourse, StudyReview } from "./contracts/study.ts";
import type { StudyStore } from "./ports.ts";

export type StudyChange =
	| { kind: "course"; course: StudyCourse }
	| { kind: "course-removed"; id: string }
	| { kind: "cards"; cards: StudyCard[] }
	| { kind: "card-removed"; id: string }
	| { kind: "reviews"; reviews: StudyReview[] };

export interface MemoryStudyInit {
	courses?: readonly StudyCourse[];
	cards?: readonly StudyCard[];
	reviews?: readonly StudyReview[];
}

export function createMemoryStudyStore(init: MemoryStudyInit = {}, onChange?: (change: StudyChange) => void): StudyStore {
	const courses = new Map<string, StudyCourse>((init.courses ?? []).map((c) => [c.id, c]));
	const cards = new Map<string, StudyCard>((init.cards ?? []).map((c) => [c.id, c]));
	const reviews: StudyReview[] = [...(init.reviews ?? [])];
	const tell = (change: StudyChange) => onChange?.(change);

	return {
		upsertCourse(course) {
			courses.set(course.id, course);
			tell({ kind: "course", course });
		},
		removeCourse(id) {
			if (courses.delete(id)) tell({ kind: "course-removed", id });
		},
		readCourses: () => [...courses.values()],

		upsertCard(card) {
			cards.set(card.id, card);
			tell({ kind: "cards", cards: [card] });
		},
		upsertCards(batch) {
			if (batch.length === 0) return;
			for (const card of batch) cards.set(card.id, card);
			tell({ kind: "cards", cards: [...batch] });
		},
		removeCard(id) {
			if (cards.delete(id)) tell({ kind: "card-removed", id });
		},
		readCards: () => [...cards.values()],

		appendReview(review) {
			reviews.push(review);
			tell({ kind: "reviews", reviews: [review] });
		},
		appendReviews(batch) {
			if (batch.length === 0) return;
			reviews.push(...batch);
			tell({ kind: "reviews", reviews: [...batch] });
		},
		readReviews: () => [...reviews],
	};
}
