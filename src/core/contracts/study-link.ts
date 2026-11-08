/**
 * Study ↔ lesson links (Learnbox 2.0, 2026-11, Slice 9 "Verknüpfungen")
 *
 * A lesson (teach session) can belong to a course (Fach) and can start from flashcards the
 * learner keeps getting wrong. The lesson's first message is preceded by a `study-context`
 * marker (core/study-link.ts) that tells the teacher about the course and those cards; this
 * file holds the shapes the marker, the weak-spot list and the draft share. Cards appear as
 * plain text here — the review screen's HTML never reaches the model or the lesson cards.
 */

/** A flashcard as a lesson sees it: both faces as plain text, capped. */
export interface StudyLinkCard {
	id: string;
	front: string;
	back: string;
	/** Reviews that failed after the card was learned (FSRS lapses). */
	lapses: number;
}

/** The course part of the marker. */
export interface StudyContextCourse {
	id: string;
	name: string;
	topics: string[];
	/** Only these topics count for the course. */
	strictTopics?: boolean;
	/** Exam day "YYYY-MM-DD". */
	deadline?: string;
	/** Days from today to the exam day (0 = today, negative = passed); null without a deadline. */
	daysToExam: number | null;
}

/** The `study-context` marker's UI payload (details): what the teacher is told. */
export interface StudyContextData {
	course: StudyContextCourse;
	/** Cards waiting for review now (learning + review) and new cards still to introduce today. */
	due: number;
	newToday: number;
	/** The course's weakest cards (most lapses), without the ones picked for this lesson. */
	weak: StudyLinkCard[];
	/** The cards the learner started this lesson from (empty: started for the course only). */
	cards: StudyLinkCard[];
	/** The subdecks (topics) the lesson is limited to when it starts from a phone that holds only some of the course's subdecks; the empty name stands for the cards that have none. The state and the weak cards above come from these only. */
	subdecks?: string[];
}

/** GET /api/study/weak?course=… — the course's weak-spot list. */
export interface StudyWeakSpots {
	courseId: string;
	cards: StudyLinkCard[];
}

/** POST /api/chats `study` — start a lesson for a course, optionally from cards (ids only; the server reads the text). */
export interface StudyLessonStart {
	courseId: string;
	cardIds?: string[];
	/** Limit the lesson to these subdecks of the course (a phone that holds the course in part). */
	topics?: string[];
}

/** A card needs this many lapses to count as a weak spot. */
export const WEAK_MIN_LAPSES = 2;
/** The weak-spot list shows at most this many cards. */
export const WEAK_LIST_LIMIT = 50;
/** The teacher hears about this many weak cards besides the picked ones. */
export const CONTEXT_WEAK_LIMIT = 5;
/** A lesson can start from at most this many cards. */
export const LESSON_CARDS_MAX = 12;
/** Each card face is cut to this many characters. */
export const LINK_TEXT_CAP = 280;
