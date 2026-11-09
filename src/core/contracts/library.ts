/**
 * Lecture library contracts (Learnbox, 2026-10): the learner's lecture PDFs,
 * stored once and reused across sessions. The library is a CURRICULUM source,
 * never learner knowledge — nothing here is written to the graph (the graph
 * holds what the learner understands; a lecture only says what exists to
 * learn). The outline is the topic structure a later step derives from the
 * PDF so the prober and the plan can aim at chosen topics and depths.
 */

/** Schema stamp on every record (same law as the chat and graph families:
 *  a newer stamp is refused on read, never half-understood). */
export const LIBRARY_SCHEMA = 1;

/** Upper bound for one lecture PDF — slide decks with figures run large. */
export const MAX_LECTURE_BYTES = 60 * 1024 * 1024;

export type LectureStatus = "stored" | "outlining" | "ready" | "failed";

/** One topic of a lecture, with the pages it spans (1-based, inclusive). */
export interface LectureTopic {
	id: string;
	title: string;
	summary: string;
	pageStart: number;
	pageEnd: number;
}

export interface LectureOutline {
	topics: LectureTopic[];
	generatedAt: string;
	/** Pages with almost no extractable text (image-only slides, scans): the
	 *  outline could not read them, and says so instead of guessing. */
	thinPages?: number[];
}

export interface LectureSource {
	v: typeof LIBRARY_SCHEMA;
	id: string;
	/** Display title, derived from the file name until renamed. */
	title: string;
	/** The uploaded file's base name (never a path). */
	fileName: string;
	bytes: number;
	/** Content hash: the same PDF uploaded twice is stored once. */
	sha256: string;
	/** Null until the page count is read. */
	pages: number | null;
	addedAt: string;
	status: LectureStatus;
	/** Why the last outline run failed (status "failed" only). */
	error?: string;
	/** Outline windows finished so far (status "outlining" only). */
	progress?: { done: number; total: number };
	outline?: LectureOutline;
}

export type LibraryErrorCode = "empty" | "not_pdf" | "too_large" | "unreadable";

/** A refusal the upload route maps to a clean 4xx — never a crash. */
export class LibraryError extends Error {
	readonly code: LibraryErrorCode;
	constructor(code: LibraryErrorCode, message: string) {
		super(message);
		this.name = "LibraryError";
		this.code = code;
	}
}

// ─── Session selection (what the learner picks before probing) ───────────────

/** How deep the learner wants to go on one topic. Single-sourced: the
 *  checklist labels, the marker text the agents read and the doctrine all
 *  use these three and the guide below. */
export const LECTURE_DEPTHS = ["overview", "mechanism", "derivation"] as const;
export type LectureDepth = (typeof LECTURE_DEPTHS)[number];
export const DEFAULT_LECTURE_DEPTH: LectureDepth = "mechanism";

/** What each depth asks of the teaching — the goal the probe measures
 *  against and the plan aims at. */
export const LECTURE_DEPTH_GUIDE: Readonly<Record<LectureDepth, string>> = {
	overview: "overview — the idea, its vocabulary and where it fits; the learner can say what it is and what it is for",
	mechanism: "mechanism — why it works: the causal chain, the quantities involved and how they depend on each other",
	derivation:
		"derivation — exam level: the learner can derive the result from its premises, state its assumptions and range of validity, and use it quantitatively on new problems",
};

/** The learner's pick for one session: lectures, topics, and a depth per topic. */
export interface LectureSelection {
	lectures: Array<{ id: string; topics: Array<{ id: string; depth?: LectureDepth }> }>;
}

/** One topic as the session carries it: the outline entry plus the chosen depth. */
export interface SessionLectureTopic extends LectureTopic {
	depth: LectureDepth;
}

/** One lecture as the session carries it. `path` is what the agents hand the
 *  pdf tool; it rides the model-facing text only, never the UI payload. */
export interface SessionLecture {
	id: string;
	title: string;
	fileName: string;
	pages: number | null;
	path: string;
	topics: SessionLectureTopic[];
}

/** The lecture-context marker's UI payload (details) — the lecture card's data. */
export interface LectureContextData {
	lectures: Array<Omit<SessionLecture, "path">>;
}
