/**
 * The audio summary of a course (Learnbox 2.0, 2026-11): Claude writes a script to be read aloud from the pages of the chosen
 * PDFs, the learner edits it, and only on a click a text-to-speech service turns it into an MP3. The shapes the server, the
 * store and the Create screen share.
 */

/** none: no script yet · running: the script is being written · draft: a script (maybe with an audio file) · error: the script could not be written. */
export type AudioStatus = "none" | "running" | "draft" | "error";

/** What is kept of a course's audio summary (data/audio/<course>/audio.json). */
export interface AudioDoc {
	status: AudioStatus;
	title: string;
	script: string;
	/** The MP3 made from the current script (null: none, or the script changed since). */
	file: string | null;
	/** When that MP3 was made (ISO time; "" while there is none) — tells the player it is a new file. */
	audioAt: string;
	/** Why the script could not be written (status "error"). */
	error: string;
	/** Why the audio could not be made (the script stays as it is). */
	audioError: string;
	/** The PDFs the script was written from. */
	jobIds: string[];
}

/** A PDF of the course the script can be written from. */
export interface AudioSource {
	jobId: string;
	name: string;
	/** Pages the PDF's cards run covers (those are read). */
	pages: number;
}

/** What is going on right now: writing the script, or making the audio. */
export interface AudioRun {
	kind: "script" | "audio";
	stage: string;
	done: number;
	total: number;
}

export interface AudioView extends AudioDoc {
	courseId: string;
	run: AudioRun | null;
	sources: AudioSource[];
	/** Whether a key for the speech service is saved (never the key itself). */
	keyConfigured: boolean;
	voiceId: string;
	defaultVoiceId: string;
	/** Characters of the script (the service bills by them). */
	chars: number;
}
