/**
 * Bringing everything over from MedAnki (Learnbox 2.0, 2026-11, Slice 8): the dry run's list and the import's result.
 * The shapes server/create-migrate.ts and the "From MedAnki" panel share. MedAnki's folder is only ever read.
 */

import type { CreateJobState, LegacyMcqImport, LegacyMcqScan } from "./create.ts";

/** One PDF job of MedAnki. */
export interface MigrateJob {
	/** MedAnki's job id. */
	id: string;
	name: string;
	/** Pages in the job's range. */
	pages: number;
	/** Cards that are not thrown away. */
	cards: number;
	state: CreateJobState;
	/** The course MedAnki had it in (its subject), or null — the panel offers the choice. */
	courseId: string | null;
	/** The same job is already in Learnbox. */
	alreadyImported: boolean;
	/** Cards that already exist as study cards (the Anki import carries MedAnki's tag) and would count as adopted. */
	linkable: number;
}

/** One subject of MedAnki, which becomes a course of the same id. */
export interface MigrateCourse {
	id: string;
	name: string;
	topics: number;
	alreadyImported: boolean;
	/** Topic notes MedAnki wrote for it that would come along (0 = none, or the course has notes already). */
	notes: number;
	/** MedAnki's audio summary of it would come along (false: none, or the course has one already). */
	audio: boolean;
}

/** Where the Obsidian vault is: MedAnki's folder and the one Learnbox uses. */
export interface MigrateVault {
	/** The folder in MedAnki's settings (null: none). */
	medanki: string | null;
	medankiExists: boolean;
	/** The folder Learnbox uses now. */
	current: string;
	/** Chosen by the learner already — the import then leaves it. */
	custom: boolean;
	/** The import would set MedAnki's folder. */
	willSet: boolean;
}

export interface MigrateScan {
	dataDir: string;
	courses: MigrateCourse[];
	jobs: MigrateJob[];
	vault: MigrateVault;
	/** The multiple-choice jobs (their own list, as before). */
	mcq: LegacyMcqScan;
}

/** What the learner chose for a PDF job: whether to bring it, and into which course. */
export interface MigrateJobChoice {
	id: string;
	courseId: string | null;
}

export interface MigrateResult {
	courses: number;
	jobs: number;
	/** Jobs that were already in Learnbox. */
	alreadyThere: number;
	/** Cards that came along. */
	drafts: number;
	/** Of those: they were study cards already. */
	linked: number;
	/** Picture files copied, and ones the cards name that MedAnki did not have. */
	media: number;
	missingMedia: number;
	/** Page pictures copied (what the focus screen shows next to the cards). */
	pictures: number;
	/** Subjects whose topic notes / audio summary came along. */
	notes: number;
	audio: number;
	/** "set": MedAnki's vault is the vault now · "kept": a vault was chosen already · "none": MedAnki names none. */
	vault: "set" | "kept" | "none";
	mcq: LegacyMcqImport;
}
