/**
 * Obsidian notes (Learnbox 2.0, 2026-11): one note per topic of a course, written from the cards of that topic and the
 * pages they stand on across all PDFs of the course, saved into an Obsidian vault on request. Plus the vault itself
 * (where it is) and linking its notes to each other. The shapes the server, the stores and the Create screen share.
 */

/** A PDF of the course as the notes name it: D1, D2 … in the order the PDFs were made. */
export interface NoteSource {
	ref: string;
	jobId: string;
	name: string;
	/** The file name of the PDF's copy in the vault (links to a page point at it). */
	pdfFile: string;
}

/** A figure cut out of a PDF page for a note. */
export interface NoteFigure {
	id: string;
	/** Name in the vault. */
	file: string;
	/** Where it is kept (relative to the course's notes folder). */
	src: string;
	page: number;
	ref: string;
	caption: string;
}

/** pending: not written yet · note: written · skipped: nothing to write it from · error: the call failed. */
export type TopicNoteKind = "pending" | "note" | "skipped" | "error";

export interface TopicNote {
	/** "t01", "t02" … in the order of the course's topics. */
	id: string;
	ix: number;
	topic: string;
	kind: TopicNoteKind;
	skipReason: string;
	/** Cards the note rests on. */
	cards: number;
	/** Source pages read. */
	pages: number;
	/** The sources (D1 …) it cites. */
	refs: string[];
	markdown: string;
	words: number;
	figures: NoteFigure[];
	tags?: string[];
	/** Goes into the vault when saving. */
	include: boolean;
	error: string;
}

export type NotesStatus = "none" | "running" | "done" | "error";

/** Where a note set was last saved. */
export interface SavedNotes {
	/** The overview note of the course in the vault. */
	path: string;
	url: string;
	created: boolean;
	vault: string;
	count: number;
	/** Notes left as they were because their structure was edited (the heading above the generated text is gone). */
	skipped?: number;
	at: string;
}

/** The progress of a run that is going on. */
export interface NotesRun {
	stage: string;
	done: number;
	total: number;
}

export interface NotesView {
	status: NotesStatus;
	error: string;
	name: string;
	created: string;
	sources: NoteSource[];
	items: TopicNote[];
	saved: SavedNotes | null;
	run: NotesRun | null;
}

/** What is stored of a note set: the view without the progress of a run that is going on. */
export type NotesDoc = Omit<NotesView, "run">;

/** The vault the notes go into. */
export interface VaultInfo {
	path: string;
	exists: boolean;
	defaultPath: string;
	/** Chosen by the learner (not the default, not set from outside). */
	custom: boolean;
	/** Course folders the vault has already. */
	folders: string[];
}

/** What a run of "link the vault" came to. */
export interface LinkResult {
	/** Notes read, thereof written by the app, and thereof linked to another. */
	notes: number;
	own: number;
	linked: number;
	/** Links between two notes. */
	links: number;
	written: number;
	removed: number;
	/** Claude checked the candidates (false: chosen by similarity alone). */
	llm: boolean;
	/** Batches Claude could not judge (chosen by similarity). */
	llmFailed: number;
	/** Graph colours per course were set. */
	colors: boolean;
	at: string;
}

export interface LinkStatus {
	state: "idle" | "running" | "done" | "error";
	stage: string;
	done: number;
	total: number;
	error: string;
	last: LinkResult | null;
}
