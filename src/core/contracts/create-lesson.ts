/**
 * Lesson-card contracts (Learnbox 2.0, 2026-11, Slice 9c): flashcards made from what a LESSON
 * established. A "lesson" Create job takes the statements of the knowledge graph one lesson touched
 * (or that the learner picked on the graph), asks Claude about each — one "page" of the job is one
 * statement — and keeps the answers as DRAFTS next to the other Create drafts. Nothing reaches the
 * study ledgers until the learner adopts drafts into a course; they always become core-knowledge
 * cards there (tier 1), tied back to the statement they came from (origin "graph").
 */

import type { Adoption, CreateJobBase, CreateJobSummary, CreateLanguage, CreatePageStatus } from "./create.ts";

/** At most this many cards come from one statement. */
export const LESSON_CARDS_PER_STATEMENT = 3;

/** A job takes at most this many statements (the body is untrusted). */
export const LESSON_STATEMENTS_MAX = 200;

/** What the learner can set for a lesson-cards job. */
export interface LessonSettings {
	/** Claude model for the cards (alias like "sonnet" or a full id). */
	model: string;
	language: CreateLanguage;
	/** Cards asked for per statement (1–3). */
	maxPerStatement: number;
	/** Statements processed at the same time (1–4). */
	concurrency: number;
}

export const DEFAULT_LESSON_SETTINGS: LessonSettings = {
	model: "sonnet",
	language: "en",
	maxPerStatement: LESSON_CARDS_PER_STATEMENT,
	concurrency: 2,
};

/** One proposition of the graph as the job keeps it (the text is copied: the job is a record of what the cards were made from). */
export interface LessonStatement {
	nodeId: string;
	/** The proposition's short label — only a handle, never a question or an answer. */
	name: string;
	statement: string;
}

/** A statement as the form offers it: with what the study ledger already knows about it. */
export interface LessonStatementOption extends LessonStatement {
	/** Study cards that already come from this statement (suspended ones do not count). */
	cards: number;
}

/** Where the statements of a new job come from: one lesson, or the nodes picked on the graph. */
export interface LessonSource {
	/** The lesson (chat); absent for a graph pick. */
	chatId?: string;
	title: string;
	/** The study course the lesson belongs to (the form's preset). */
	courseId?: string;
	statements: LessonStatementOption[];
}

export interface LessonJob extends CreateJobBase {
	kind: "lesson";
	settings: LessonSettings;
	/** The subject whose core knowledge the cards become. */
	courseId: string;
	/** The lesson the statements are from; absent for a graph pick. */
	chatId?: string;
	/** Page n (1-based) of the job is `statements[n - 1]`. */
	statements: LessonStatement[];
	/** Note for the prompt on the subject (its name and topics), fixed once per job so a rerun asks the same. */
	courseNote?: string;
}

interface LessonDraftBase {
	/** "p003-c02" — statement 3, second card of it. */
	id: string;
	page: number;
	extra: string;
	/** Soft delete: thrown away by the learner (restorable). */
	deleted: boolean;
	/** Selected for adoption. */
	include: boolean;
	/** Edited by the learner. */
	edited?: boolean;
	/** Set once the draft became a study card. */
	adopted?: Adoption;
}

export interface LessonBasicDraft extends LessonDraftBase {
	type: "basic";
	front: string;
	back: string;
}

/** A sentence with gaps {{c1::…}}; each gap becomes one study card. */
export interface LessonClozeDraft extends LessonDraftBase {
	type: "cloze";
	text: string;
}

export type LessonDraft = LessonBasicDraft | LessonClozeDraft;

/** One statement's drafts. */
export interface LessonPageResult {
	page: number;
	nodeId: string;
	cards: LessonDraft[];
	/** Why the model made no card (empty when it made some). */
	note: string;
}

/** One statement for the draft list. */
export interface LessonJobPageView {
	page: number;
	status: CreatePageStatus;
	error?: string;
	statement: LessonStatement;
	cards: LessonDraft[];
	note: string;
}

export interface LessonJobDetail {
	job: CreateJobSummary;
	settings: LessonSettings;
	chatId?: string;
	pages: LessonJobPageView[];
}
