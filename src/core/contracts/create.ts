/**
 * Create contracts (Learnbox 2.0, 2026-11): turning a library PDF into study
 * material. A CREATE JOB walks the pages of one lecture PDF, asks Claude about
 * each page, and keeps the answers as DRAFTS — nothing reaches the study
 * ledgers until the learner picks drafts and adopts them into a course
 * (core/contracts/study.ts). The job record is the progress book (page
 * statuses), the page results are the drafts; both live apart from the study
 * ledgers so a half-finished or rejected run leaves the learner's cards
 * untouched.
 *
 * Ported from MedAnki's MC-test generator (medanki/mcq.py); the "cards" kind
 * (cards from a PDF, core/contracts/create-cards.ts) shares this record.
 */

import type { CardSettings, GlossaryTerm } from "./create-cards.ts";
import type { LessonJob } from "./create-lesson.ts";

/** Schema stamp on every job record (a newer stamp is refused on read). */
export const CREATE_SCHEMA = 1;

export type CreateJobKind = "mcq" | "cards" | "lesson";

export type CreateJobState = "queued" | "running" | "done" | "stopped" | "interrupted";

export type CreatePageStatus = "pending" | "running" | "done" | "error";

/** Language of the generated material: a fixed one, or the page's own. */
export const CREATE_LANGUAGES = ["en", "de", "auto"] as const;
export type CreateLanguage = (typeof CREATE_LANGUAGES)[number];

/** One page's progress in a job. */
export interface CreatePage {
	status: CreatePageStatus;
	/** Why the page failed (status "error" only). */
	error?: string;
	/** Drafts the page holds now (not deleted). */
	count: number;
	/** Of those, the ones already adopted into a course. */
	adopted: number;
	/** Cards jobs: the model's short title of the page, and whether it left the page out (no learnable content). */
	topic?: string;
	skipped?: boolean;
}

/** What the learner can set for an MC-test job. */
export interface McqSettings {
	/** Claude model for the questions (alias like "sonnet" or a full id). */
	model: string;
	language: CreateLanguage;
	/** Questions asked for per page (1–10). */
	questionsPerPage: number;
	/** 1-based, inclusive; the job clamps them to the PDF. */
	pageFrom: number;
	pageTo: number;
	/** Pages processed at the same time (1–4). */
	concurrency: number;
}

export const DEFAULT_MCQ_SETTINGS: McqSettings = {
	model: "sonnet",
	language: "en",
	questionsPerPage: 4,
	pageFrom: 1,
	pageTo: 0, // 0 = to the end
	concurrency: 2,
};

export interface CreateJobBase {
	v: typeof CREATE_SCHEMA;
	id: string;
	/** Display name, derived from the lecture (or the lesson) until renamed. */
	name: string;
	/** Pages of the PDF at creation (the range is clamped to it); for a lesson job, its statements. */
	nPages: number;
	state: CreateJobState;
	/** The Claude CLI needs a sign-in (or the plan's limit is hit): the run stopped on its own. */
	blocked?: string;
	/** An unexpected failure of the run itself (not of one page). */
	fatal?: string;
	createdAt: string;
	/** Pages in the job's range, by page number as a string. */
	pages: Record<string, CreatePage>;
}

/** A job made from a library PDF. */
interface PdfJobBase extends CreateJobBase {
	/** The library PDF the material is made from (data/library). */
	lectureId: string;
	/** An optional second library PDF — the factual source (e.g. the lecture
	 *  slides) when the main PDF is a question sheet; its text rides in every page prompt. */
	sourceLectureId?: string;
}

export interface McqJob extends PdfJobBase {
	kind: "mcq";
	settings: McqSettings;
}

export interface CardsJob extends PdfJobBase {
	kind: "cards";
	settings: CardSettings;
	/** The subject (study course) the PDF belongs to: its topics were the focus when the job was made, and its drafts are adopted there. */
	courseId?: string;
	/** Note for the page prompt from how the subject was remembered so far ("" = none); fixed once per job so a rerun asks the same. */
	retentionHint?: string;
	/** Latin anatomical terms on/off, decided once before the first page. */
	latin?: boolean;
	/** The term glossary of the document, built once (absent = not built yet). */
	glossary?: GlossaryTerm[];
	/** The title of every page of the range, found once; the page prompt names the neighbours as context. */
	headings?: Record<string, string>;
}

export type CreateJob = McqJob | CardsJob | LessonJob;

export const MCQ_LETTERS = ["A", "B", "C", "D"] as const;
export type McqLetter = (typeof MCQ_LETTERS)[number];

/** Where an adopted draft went. */
export interface Adoption {
	courseId: string;
	cardId: string;
	at: string;
}

/** One draft question. `id` is "p003-q02" (page 3, second question of the page). */
export interface McqQuestion {
	id: string;
	page: number;
	question: string;
	options: Record<McqLetter, string>;
	/** Letters of ALL correct options, sorted; 1–3 of 4. */
	correct: McqLetter[];
	/** One line per letter, in the question's language. */
	explanation: string;
	/** Soft delete: the learner threw it away (restorable until the job goes). */
	deleted: boolean;
	/** Set once the draft became a study card. */
	adopted?: Adoption;
}

export interface McqPageResult {
	page: number;
	questions: McqQuestion[];
}

/** A job for the list: the record plus what the list needs at a glance. */
export interface CreateJobSummary {
	id: string;
	kind: CreateJobKind;
	name: string;
	/** The library PDF (absent for a lesson job). */
	lectureId?: string;
	state: CreateJobState;
	running: boolean;
	blocked?: string;
	fatal?: string;
	createdAt: string;
	nPages: number;
	/** Cards and lesson jobs: the subject the PDF belongs to / the cards are for. */
	courseId?: string;
	/** Lesson jobs: the lesson the statements are from. */
	chatId?: string;
	/** Pages in the job's range. */
	total: number;
	counts: Record<CreatePageStatus, number>;
	/** Drafts that are not deleted. */
	drafts: number;
	adopted: number;
}

/** One page for the draft list. */
export interface CreateJobPageView {
	page: number;
	status: CreatePageStatus;
	error?: string;
	questions: McqQuestion[];
}

export interface CreateJobDetail {
	job: CreateJobSummary;
	settings: McqSettings;
	pages: CreateJobPageView[];
}

/** A refusal the create routes map to a clean 4xx (or 502 when Claude failed) — never a crash. */
export class CreateInputError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404 | 409 | 502,
	) {
		super(message);
		this.name = "CreateInputError";
	}
}

// ─── MedAnki's multiple-choice jobs, brought over (server/create-legacy.ts) ──

export interface LegacyMcqJob {
	/** MedAnki's job id. */
	id: string;
	name: string;
	pages: number;
	questions: number;
	/** The same job is already in Learnbox. */
	alreadyImported: boolean;
	/** Questions that already exist as study cards (the Anki import) and would be marked adopted. */
	linkable: number;
}

export interface LegacyMcqScan {
	dataDir: string;
	jobs: LegacyMcqJob[];
}

export interface LegacyMcqImport {
	imported: number;
	alreadyThere: number;
	questions: number;
	linked: number;
}
