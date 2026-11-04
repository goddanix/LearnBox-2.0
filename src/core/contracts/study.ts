/**
 * Study contracts — courses, flashcards, reviews, deadlines
 *
 * The spaced-repetition domain that replaces Anki + the Deadline Scheduler
 * add-on inside Learnbox. Same doctrine as the knowledge graph: the stored
 * truth is append-only (cards, reviews); everything scheduled is DERIVED by
 * folding the review ledger through FSRS (core/fsrs.ts) — a card's memory
 * state is never stored, so changing parameters re-derives every card.
 *
 * Dates are ISO-8601 strings (JSON-safe, sortable); `day` fields are local
 * calendar dates "YYYY-MM-DD". Pure types + tiny pure helpers.
 */

/** Review grade, Anki's buttons: 1 Again, 2 Hard, 3 Good, 4 Easy. */
export type StudyGrade = 1 | 2 | 3 | 4;

/** FSRS card phase (ts-fsrs State): 0 New, 1 Learning, 2 Review, 3 Relearning. */
export type StudyPhase = 0 | 1 | 2 | 3;

export type StudyCardKind = "basic" | "cloze" | "occlusion" | "mcq";

/** A subject (Fach). The deadline drives the new-cards-per-day quota. */
export interface StudyCourse {
	id: string;
	name: string;
	/** Exam day, local calendar date "YYYY-MM-DD"; absent = no deadline. */
	deadline?: string;
	/** Review-only days before the deadline (Deadline Scheduler default 5). */
	bufferDays: number;
	/** Manual new-cards-per-day override; absent = automatic. */
	newPerDay?: number;
	createdAt: string;
}

/** Where a card came from — the cross-feature links (PDF, graph, Anki). */
export type StudyCardOrigin =
	| { kind: "pdf"; jobId: string; page?: number }
	| { kind: "graph"; nodeId: string }
	| { kind: "anki-import"; noteId: number }
	| { kind: "manual" };

/** One stored flashcard. Fields are kind-specific named strings
 *  (basic: Front/Back; cloze: Text/Extra; …) — the .apkg export maps them. */
export interface StudyCard {
	id: string;
	courseId: string;
	topic?: string;
	kind: StudyCardKind;
	fields: Record<string, string>;
	tags: string[];
	/** Core-knowledge card (MedAnki::Kernwissen): introduced before others. */
	core: boolean;
	origin: StudyCardOrigin;
	/** Which card of its note: the template index (basic: 0 forward, 1
	 *  reverse) or the cloze number minus one. Absent for a one-card note. */
	variant?: number;
	createdAt: string;
	/** True once the card is suspended / deleted (a later line wins). */
	suspended?: boolean;
}

/** One answered review — the ledger line. */
export interface StudyReview {
	cardId: string;
	at: string;
	grade: StudyGrade;
	/** Review duration in ms, when known (Anki import carries it). */
	ms?: number;
}

/** A card's derived memory + schedule state (never stored). */
export interface StudyCardState {
	cardId: string;
	phase: StudyPhase;
	due: string;
	stability: number;
	difficulty: number;
	scheduledDays: number;
	reps: number;
	lapses: number;
	lastReview?: string;
	learningSteps: number;
}

// ─── review-screen wire types (GET/POST /api/study/*) ────────────────────────

/** Cards waiting in a course's queue right now. */
export interface StudyQueueCounts {
	new: number;
	learning: number;
	review: number;
}

/** One row of the "which course?" screen. */
export interface StudyCourseSummary {
	id: string;
	name: string;
	deadline?: string;
	/** Days to the deadline while it is active (buffer included), else null. */
	daysLeft: number | null;
	total: number;
	counts: StudyQueueCounts;
	newQuota: number;
}

/** The card on screen: both sides pre-rendered (script-free HTML, media inlined as data: URIs). */
export interface StudyCardView {
	id: string;
	kind: StudyCardKind;
	bucket: "new" | "learning" | "review";
	core: boolean;
	topic?: string;
	front: string;
	back: string;
	/** Bildcloze: figure left, gaps right — the page gives the card the full pane width. */
	split: boolean;
	/** Interval label per grade, e.g. { 1: "1m", 2: "6m", 3: "10m", 4: "3d" }. */
	intervals: Record<StudyGrade, string>;
}

/** Answer to "next card" — `card` is null once the course is done for today. */
export interface StudyNextResult {
	courseId: string;
	counts: StudyQueueCounts;
	/** Step counter the client sends back (the queue pattern's position). */
	step: number;
	card: StudyCardView | null;
}
