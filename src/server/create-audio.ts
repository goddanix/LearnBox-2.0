/**
 * The audio summary of a course (Learnbox 2.0, 2026-11), ported from MedAnki's audio.py: Claude writes a script to be read
 * aloud from the pages of the chosen PDFs of the course (it explains the material and teaches how to remember it); the learner
 * can edit it; only on a click the ElevenLabs API turns it into an MP3. Two separate steps on purpose: the script costs one
 * Claude call, the audio costs real ElevenLabs credit. The rules are core/audio-script.ts, the prompt
 * agent/create/audio-prompts.ts, the HTTP client agent/audio/elevenlabs.ts, the files store/audio.ts; here: the runs,
 * Claude, the pages, and the glue.
 *
 * Unlike MedAnki the audio is made in the background too (a request for a long script can take minutes): the screen polls.
 * Not ported: several summaries per course (one per course, as in MedAnki).
 */

import * as fs from "node:fs";
import { DEFAULT_VOICE_ID, elevenSpeech, type Speak, SpeechError, speakScript } from "../agent/audio/elevenlabs.ts";
import { SCRIPT_SYSTEM, scriptPrompt } from "../agent/create/audio-prompts.ts";
import { type AudioDocument, audioMaterial, clipTitle, scriptBudget, speechChars } from "../core/audio-script.ts";
import { CreateInputError } from "../core/contracts.ts";
import type { AudioRun, AudioSource, AudioView } from "../core/contracts/create-audio.ts";
import { pageNumbers } from "../core/create.ts";
import { pageText } from "../core/topic-notes.ts";
import { audioStore, type AudioStore, emptyAudioDoc } from "../store/audio.ts";
import { type CardsDeps, defaultCardsDeps } from "./create-cards.ts";
import { jobsOf, layoutFor, requireCourse } from "./create-notes.ts";
import { askJson, errorText, RunBlocked } from "./create-shared.ts";

/** The model that writes the script (MedAnki's default model for the big jobs). */
export const AUDIO_MODEL = "sonnet";
/** The file the audio is kept in. */
const AUDIO_FILE = "summary.mp3";

/** What the audio summary needs on top of a cards run's collaborators. */
export interface AudioDeps extends CardsDeps {
	audio: AudioStore;
	/** Text → MP3 (the ElevenLabs API). */
	speak: Speak;
	/** The key of the speech service, "" while none is saved. */
	apiKey: () => string;
}

export const defaultAudioDeps = (): AudioDeps => ({
	...defaultCardsDeps(),
	audio: audioStore,
	speak: elevenSpeech,
	// the settings page's key store reflects its keys into the environment (see server/keys.ts)
	apiKey: () => process.env.ELEVENLABS_API_KEY?.trim() ?? "",
});

// ─── the runs ────────────────────────────────────────────────────────────────

/** The runs, by course (on globalThis for the same reason as the notes runs: Next may load this module once per route bundle). */
const live = globalThis as typeof globalThis & { __lbAudioRuns?: Map<string, AudioRun> };
const runs = (live.__lbAudioRuns ??= new Map<string, AudioRun>());

const INTERRUPTED = "The run was interrupted — please write the script again.";

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The stored summary, but with a script run that no longer exists reported honestly. */
function readDoc(courseId: string, deps: Pick<AudioDeps, "audio">) {
	const doc = deps.audio.read(courseId) ?? emptyAudioDoc();
	if (doc.status !== "running" || runs.has(courseId)) return doc;
	return deps.audio.update(courseId, (d) => Object.assign(d, { status: "error", error: INTERRUPTED }));
}

function sourcesOf(courseId: string, deps: Pick<AudioDeps, "study" | "create">): AudioSource[] {
	return jobsOf(courseId, deps).map((job) => ({ jobId: job.id, name: job.name, pages: pageNumbers(job).length }));
}

const voiceOf = (deps: Pick<AudioDeps, "audio">): string => deps.audio.voice() ?? DEFAULT_VOICE_ID;

/** The audio summary of a course, with the run that is going on, the PDFs to choose from and what the speech service needs. */
export function getAudio(courseId: string, deps: AudioDeps = defaultAudioDeps()): AudioView {
	requireCourse(courseId, deps);
	const doc = readDoc(courseId, deps);
	return {
		...doc,
		courseId,
		run: runs.get(courseId) ?? null,
		sources: sourcesOf(courseId, deps),
		keyConfigured: deps.apiKey() !== "",
		voiceId: voiceOf(deps),
		defaultVoiceId: DEFAULT_VOICE_ID,
		chars: speechChars(doc.script),
	};
}

/** Choose the voice (null or "" = back to the default). Returns the voice in use. */
export function setVoice(raw: unknown, deps: Pick<AudioDeps, "audio"> = defaultAudioDeps()): string {
	if (raw !== null && raw !== undefined && typeof raw !== "string") throw new CreateInputError("The voice ID must be text", 400);
	const id = (raw ?? "").trim();
	if (id && !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new CreateInputError("The voice ID is not valid (letters, digits, - and _ only).", 400);
	deps.audio.setVoice(id || null);
	return voiceOf(deps);
}

function launch(courseId: string, kind: AudioRun["kind"], stage: string, work: (run: AudioRun) => Promise<void>): boolean {
	if (runs.has(courseId)) return false;
	const run: AudioRun = { kind, stage, done: 0, total: 0 };
	runs.set(courseId, run);
	void work(run).finally(() => runs.delete(courseId));
	return true;
}

// ─── the script ──────────────────────────────────────────────────────────────

/** Write the script of a course from the chosen PDFs. Never throws: the outcome is in the stored summary. */
async function runScript(courseId: string, jobIds: readonly string[], run: AudioRun, deps: AudioDeps): Promise<void> {
	deps.audio.update(courseId, (d) => Object.assign(d, { status: "running", error: "", audioError: "", jobIds: [...jobIds] }));
	try {
		const course = requireCourse(courseId, deps);
		const chosen = jobsOf(courseId, deps).filter((j) => jobIds.includes(j.id));
		const total = chosen.reduce((n, job) => n + pageNumbers(job).length, 0);
		Object.assign(run, { stage: "Reading the pages", done: 0, total });
		const docs: AudioDocument[] = [];
		for (const job of chosen) {
			const pages: { page: number; text: string }[] = [];
			for (const page of pageNumbers(job)) {
				pages.push({ page, text: pageText(await layoutFor(job, page, deps)) });
				run.done++;
			}
			docs.push({ name: job.name, pages });
		}
		const material = audioMaterial(docs);
		if (!material.text.trim()) throw new CreateInputError("No text found in the chosen PDFs.", 400);
		Object.assign(run, { stage: "Writing the script (Claude)", done: 0, total: 0 });
		const raw = await askJson(deps, {
			prompt: scriptPrompt(course.name, scriptBudget(material.totalPages), material.text),
			system: SCRIPT_SYSTEM,
			cwd: deps.create.workDir(`audio_${courseId}`),
			model: AUDIO_MODEL,
			signal: new AbortController().signal,
		});
		const script = text(raw.script).trim();
		if (!script) throw new Error("Claude gave no script.");
		const title = clipTitle(text(raw.title) || course.name);
		const old = deps.audio.read(courseId)?.file;
		if (old) deps.audio.removeFile(courseId, old);
		deps.audio.update(courseId, (d) => Object.assign(d, { status: "draft", title, script, file: null, audioAt: "", error: "", audioError: "" }));
	} catch (err) {
		const message =
			err instanceof RunBlocked ? `Claude is not available: ${err.message}` : err instanceof CreateInputError ? err.message : `The script could not be written: ${errorText(err).slice(0, 300)}`;
		deps.audio.update(courseId, (d) => Object.assign(d, { status: "error", error: message }));
	}
}

/** Write the script (in the background; poll getAudio). False if something is going on for this course already. */
export function startScript(courseId: string, input: { jobIds?: unknown }, deps: AudioDeps = defaultAudioDeps()): boolean {
	requireCourse(courseId, deps);
	if (input.jobIds !== undefined && (!Array.isArray(input.jobIds) || input.jobIds.some((j) => typeof j !== "string"))) {
		throw new CreateInputError("`jobIds` must be a list of PDF ids", 400);
	}
	const valid = new Set(sourcesOf(courseId, deps).map((s) => s.jobId));
	const jobIds = [...new Set((input.jobIds as string[] | undefined) ?? [])].filter((id) => valid.has(id));
	if (jobIds.length === 0) throw new CreateInputError("Please choose at least one PDF of this course.", 400);
	return launch(courseId, "script", "Starting", (run) => runScript(courseId, jobIds, run, deps));
}

/** Change the title or the script by hand (a changed script no longer fits its audio: that is dropped). */
export function updateScript(courseId: string, input: { title?: unknown; script?: unknown }, deps: AudioDeps = defaultAudioDeps()): AudioView {
	requireCourse(courseId, deps);
	if (runs.has(courseId)) throw new CreateInputError("Something is going on for this course — please wait.", 409);
	if (input.title !== undefined && typeof input.title !== "string") throw new CreateInputError("The title must be text", 400);
	if (input.script !== undefined && typeof input.script !== "string") throw new CreateInputError("The script must be text", 400);
	const doc = readDoc(courseId, deps);
	if (typeof input.script === "string" && !input.script.trim()) throw new CreateInputError("The script must not be empty.", 400);
	if (input.script !== undefined && doc.status !== "draft") throw new CreateInputError("There is no script to change yet.", 400);
	const script = typeof input.script === "string" ? input.script.replace(/\r\n/g, "\n").trim() : null;
	if (script !== null && script !== doc.script && doc.file) deps.audio.removeFile(courseId, doc.file);
	deps.audio.update(courseId, (d) => {
		if (typeof input.title === "string") d.title = clipTitle(input.title);
		if (script !== null && script !== d.script) Object.assign(d, { script, file: null, audioAt: "", audioError: "" });
	});
	return getAudio(courseId, deps);
}

// ─── the audio ───────────────────────────────────────────────────────────────

/**
 * Make the MP3 of the current script (in the background; poll getAudio). It costs ElevenLabs credit, so it only ever happens on
 * a click. False if something is going on for this course already.
 */
export function startAudio(courseId: string, deps: AudioDeps = defaultAudioDeps()): boolean {
	requireCourse(courseId, deps);
	const doc = readDoc(courseId, deps);
	if (doc.status !== "draft" || !doc.script.trim()) throw new CreateInputError("Write a script first.", 400);
	const apiKey = deps.apiKey();
	if (!apiKey) throw new CreateInputError("No ElevenLabs API key is saved yet (Settings → Keys).", 400);
	const { script } = doc;
	return launch(courseId, "audio", "Creating the audio", async (run) => {
		try {
			const audio = await speakScript(script, { voiceId: voiceOf(deps), apiKey }, deps.speak, (done, total) => Object.assign(run, { done, total }));
			const old = deps.audio.read(courseId)?.file;
			if (old && old !== AUDIO_FILE) deps.audio.removeFile(courseId, old);
			deps.audio.writeFile(courseId, AUDIO_FILE, audio);
			deps.audio.update(courseId, (d) => Object.assign(d, { file: AUDIO_FILE, audioAt: deps.now().toISOString(), audioError: "" }));
		} catch (err) {
			const message = err instanceof SpeechError ? err.message : `The audio could not be made: ${errorText(err).slice(0, 300)}`;
			deps.audio.update(courseId, (d) => Object.assign(d, { audioError: message }));
		}
	});
}

/** The MP3 of the summary (found through the stored name, never a free path). */
export function audioFile(courseId: string, deps: AudioDeps = defaultAudioDeps()): { file: string; size: number } {
	requireCourse(courseId, deps);
	const name = readDoc(courseId, deps).file;
	const file = name ? deps.audio.fileOf(courseId, name) : null;
	if (!file) throw new CreateInputError("There is no audio yet.", 404);
	return { file, size: fs.statSync(file).size };
}
