/**
 * The audio summary of a course (src/server/create-audio.ts) with a SCRIPTED model, a stand-in for ElevenLabs and throw-away
 * stores: writing the script from the pages, a refused or failed call, editing, making the audio (one request, or cut into
 * pieces), a failed audio, the voice — never data/*, never the real Claude CLI, never the real (paid) speech service.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { elevenSpeech } from "../src/agent/audio/elevenlabs.ts";
import { type AskClaude, type AskClaudeRequest, ClaudeAskError } from "../src/agent/claude-ask.ts";
import { SCRIPT_SYSTEM } from "../src/agent/create/audio-prompts.ts";
import { CreateInputError, type CardsJob, type LectureSource } from "../src/core/contracts.ts";
import { DEFAULT_CARD_SETTINGS } from "../src/core/contracts/create-cards.ts";
import type { Box, PageLayout, PageLine } from "../src/core/contracts/page-layout.ts";
import type { LibraryStore } from "../src/core/ports.ts";
import { type AudioDeps, audioFile, getAudio, setVoice, startAudio, startScript, updateScript } from "../src/server/create-audio.ts";
import { createAudioStore } from "../src/store/audio.ts";
import { createCreateStore } from "../src/store/create.ts";
import { createStudyStore } from "../src/store/study.ts";
import { type FakeElevenLabs, framesFor, SILENT_FRAME, startFakeElevenLabs } from "./fixtures/fake-elevenlabs.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-audio-"));
const fakes: FakeElevenLabs[] = [];
after(async () => {
	await Promise.all(fakes.map((f) => f.close())); // also those of a test that failed before it closed its own
	fs.rmSync(root, { recursive: true, force: true });
});

const NOW = new Date(2026, 10, 5, 10, 0, 0);
const KEY = "test-key-not-a-secret-0123456789";
const json = (value: unknown) => ({ text: JSON.stringify(value), costUsd: 0, durationMs: 1 });

const line = (id: string, text: string, bbox: Box, extra: Partial<PageLine> = {}): PageLine => ({ id, text, bbox, tight: null, size: 10, src: "pdf", bold: false, italic: false, underline: false, inFigure: false, ...extra });

/** A page with a title, a highlighted sentence and a plain one. */
function layoutFor(n: number, body = `Blood backs up into the lungs in case ${n}.`): PageLayout {
	const lines = [line("L1", `Page ${n}`, [0.1, 0.05, 0.9, 0.1], { bold: true, size: 20 }), line("L2", body, [0.1, 0.2, 0.9, 0.24])];
	return { widthPt: 600, heightPt: 800, lines, figures: [], legends: [], chars: 80, title: `Page ${n}` };
}

let counter = 0;

interface Options {
	script?: (req: AskClaudeRequest) => unknown;
	key?: string;
	maxChars?: number;
}

async function setup(options: Options = {}) {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const create = createCreateStore(path.join(dir, "create"));
	const study = createStudyStore({ courses: path.join(dir, "courses.jsonl"), cards: path.join(dir, "cards.jsonl"), reviews: path.join(dir, "reviews.jsonl") });
	study.upsertCourse({ id: "cardio", name: "Cardiology", bufferDays: 5, createdAt: NOW.toISOString() });
	study.upsertCourse({ id: "other", name: "Other", bufferDays: 5, createdAt: NOW.toISOString() });
	const asked: AskClaudeRequest[] = [];
	const library: LibraryStore = {
		add: () => {
			throw new Error("not used");
		},
		get: () => null,
		list: (): LectureSource[] => [],
		update: () => null,
		pdfPath: () => null,
		remove: () => false,
	};
	const ask: AskClaude = async (req) => {
		asked.push(req);
		if (req.system !== SCRIPT_SYSTEM) throw new Error(`unexpected call: ${req.system.slice(0, 40)}`);
		return json(options.script?.(req) ?? { title: "The heart in ten minutes", script: "First the atria fill. Then the ventricles contract." });
	};
	const fake = await startFakeElevenLabs({ maxChars: options.maxChars ?? null });
	fakes.push(fake);
	const deps: AudioDeps = {
		create,
		library,
		study,
		ask,
		renderPage: async () => new Uint8Array(),
		pageLines: async () => [],
		documentText: async () => "",
		addPdf: async () => {
			throw new Error("not used");
		},
		now: () => NOW,
		retryDelayMs: 0,
		openPdf: async () => {
			throw new Error("not used");
		},
		layouts: async () => {
			throw new Error("the layouts are kept: nothing is read from a PDF");
		},
		recognize: async () => [],
		studyMediaDir: path.join(dir, "media"),
		audio: createAudioStore(path.join(dir, "audio")),
		speak: (request) => elevenSpeech(request, { base: fake.base }),
		apiKey: () => options.key ?? KEY,
	};
	/** A finished cards job of the course with these pages (their layouts kept, as after a real run). */
	function addJob(name: string, pages: Record<number, string | null>, courseId = "cardio"): string {
		const id = `crt_audio_${++counter}`;
		const job: CardsJob = {
			v: 1,
			id,
			kind: "cards",
			name,
			lectureId: `lec${counter}`,
			nPages: 9,
			settings: { ...DEFAULT_CARD_SETTINGS, focusTopics: [], focusStrict: false },
			courseId,
			state: "done",
			createdAt: new Date(NOW.getTime() + counter * 1000).toISOString(),
			pages: Object.fromEntries(Object.keys(pages).map((n) => [n, { status: "done", count: 0, adopted: 0 }])),
		};
		create.createJob(job);
		for (const [n, body] of Object.entries(pages)) create.writeLayout(id, Number(n), body === null ? { ...layoutFor(Number(n)), lines: [] } : layoutFor(Number(n), body));
		return id;
	}
	return { deps, asked, fake, addJob, create };
}

/** Waits until the run for the course is over. */
async function settled(deps: AudioDeps, courseId = "cardio"): Promise<ReturnType<typeof getAudio>> {
	for (let i = 0; i < 400; i++) {
		const view = getAudio(courseId, deps);
		if (view.run === null) return view;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("the run did not finish");
}

const refused = (status: number, pattern: RegExp) => (e: unknown) => e instanceof CreateInputError && e.status === status && pattern.test(e.message);

describe("looking at a course's audio summary", () => {
	it("starts empty, lists the PDFs of the course, and knows about the key and the voice", async () => {
		const { deps, addJob, fake } = await setup({ key: "" });
		addJob("01_Heart lecture", { 3: "x", 5: "y" });
		addJob("Not this course", { 1: "z" }, "other");
		const view = getAudio("cardio", deps);
		assert.equal(view.status, "none");
		assert.equal(view.script, "");
		assert.equal(view.file, null);
		assert.equal(view.run, null);
		assert.deepEqual(view.sources.map((s) => [s.name, s.pages]), [["01_Heart lecture", 2]]);
		assert.equal(view.keyConfigured, false);
		assert.equal(view.voiceId, view.defaultVoiceId);
		assert.equal(view.chars, 0);
		assert.throws(() => getAudio("nope", deps), refused(404, /Unknown course/));
		await fake.close();
	});
});

describe("writing the script", () => {
	it("needs at least one PDF of this course", async () => {
		const { deps, addJob, fake } = await setup();
		const other = addJob("Other lecture", { 1: "x" }, "other");
		assert.throws(() => startScript("cardio", {}, deps), refused(400, /at least one PDF/));
		assert.throws(() => startScript("cardio", { jobIds: [other, "crt_nope"] }, deps), refused(400, /at least one PDF/), "PDFs of another course do not count");
		assert.throws(() => startScript("cardio", { jobIds: "all" }, deps), refused(400, /list of PDF ids/));
		assert.throws(() => startScript("nope", { jobIds: [] }, deps), refused(404, /Unknown course/));
		await fake.close();
	});

	it("gives Claude the pages of the chosen PDFs, and keeps the script as a draft", async () => {
		const { deps, asked, addJob, fake } = await setup();
		const a = addJob("01_Heart lecture", { 3: "Atria fill first.", 4: null, 5: "Valves open." });
		addJob("Not chosen", { 1: "Secret." });
		assert.equal(startScript("cardio", { jobIds: [a, a, "crt_nope"] }, deps), true);
		assert.equal(startScript("cardio", { jobIds: [a] }, deps), false, "a run is going already");
		assert.equal(getAudio("cardio", deps).status, "running");
		const view = await settled(deps);

		assert.equal(view.status, "draft");
		assert.equal(view.error, "");
		assert.equal(view.title, "The heart in ten minutes");
		assert.equal(view.script, "First the atria fill. Then the ventricles contract.");
		assert.deepEqual(view.jobIds, [a]);
		assert.equal(view.file, null);
		assert.equal(view.chars, [..."First the atria fill. Then the ventricles contract."].length);

		assert.equal(asked.length, 1);
		const prompt = asked[0]!.prompt;
		assert.match(prompt, /^AUDIO-MODUS: skript\nDocument: Cardiology\nTarget length: about 700 spoken words \(~5 minute\(s\)/);
		assert.ok(prompt.includes("##### Dokument: 01_Heart lecture #####\n=== Seite 3 ===\n★ Page 3\nAtria fill first.\n\n=== Seite 5 ===\n★ Page 5\nValves open."), prompt);
		assert.ok(!prompt.includes("Seite 4"), "a page without text is left out");
		assert.ok(!prompt.includes("Secret."), "only the chosen PDFs");
		assert.equal(asked[0]!.model, "sonnet");
		assert.match(asked[0]!.cwd, /audio_cardio[\\/]work$/);
		await fake.close();
	});

	it("sets the length by the pages of all chosen PDFs", async () => {
		const { deps, asked, addJob, fake } = await setup();
		const pages = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 1, `text ${i}`]));
		const a = addJob("Big", pages);
		const b = addJob("Bigger", pages);
		startScript("cardio", { jobIds: [a, b] }, deps);
		await settled(deps);
		assert.match(asked[0]!.prompt, /about 1700 spoken words \(~11 minute\(s\)/, "500 + 30 × 40 pages");
		await fake.close();
	});

	it("reports honestly: no text, no script, a lost sign-in, a failed call", async () => {
		const { deps, addJob, fake } = await setup({ script: () => ({ script: "  " }) });
		const empty = addJob("Scans", { 1: null, 2: null });
		const ok = addJob("Text", { 1: "words" });
		startScript("cardio", { jobIds: [empty] }, deps);
		assert.match((await settled(deps)).error, /No text found in the chosen PDFs/);
		startScript("cardio", { jobIds: [ok] }, deps);
		let view = await settled(deps);
		assert.equal(view.status, "error");
		assert.match(view.error, /Claude gave no script/);

		const blocked = await setup();
		blocked.deps.ask = async () => {
			throw new ClaudeAskError("Not signed in", "auth");
		};
		startScript("cardio", { jobIds: [blocked.addJob("Text", { 1: "words" })] }, blocked.deps);
		view = await settled(blocked.deps);
		assert.equal(view.status, "error");
		assert.match(view.error, /Claude is not available: Not signed in/);

		const broken = await setup();
		broken.deps.ask = async () => {
			throw new ClaudeAskError("The model fell over", "other");
		};
		startScript("cardio", { jobIds: [broken.addJob("Text", { 1: "words" })] }, broken.deps);
		assert.match((await settled(broken.deps)).error, /The script could not be written: .*fell over|fell over/);
		await Promise.all([fake.close(), blocked.fake.close(), broken.fake.close()]);
	});

	it("reports a run that no longer exists as interrupted", async () => {
		const { deps, fake } = await setup();
		deps.audio.update("cardio", (d) => Object.assign(d, { status: "running" }));
		const view = getAudio("cardio", deps);
		assert.equal(view.status, "error");
		assert.match(view.error, /interrupted/);
		await fake.close();
	});

	it("a new script drops the audio of the old one", async () => {
		const { deps, addJob, fake } = await setup();
		const a = addJob("Lecture", { 1: "words" });
		startScript("cardio", { jobIds: [a] }, deps);
		await settled(deps);
		startAudio("cardio", deps);
		const made = await settled(deps);
		assert.equal(made.file, "summary.mp3");
		assert.ok(deps.audio.fileOf("cardio", "summary.mp3"));
		startScript("cardio", { jobIds: [a] }, deps);
		const view = await settled(deps);
		assert.equal(view.file, null);
		assert.equal(deps.audio.fileOf("cardio", "summary.mp3"), null);
		await fake.close();
	});
});

describe("editing the script", () => {
	async function drafted() {
		const s = await setup();
		startScript("cardio", { jobIds: [s.addJob("Lecture", { 1: "words" })] }, s.deps);
		await settled(s.deps);
		return s;
	}

	it("changes the title and the script, keeps them trimmed, and refuses an empty script", async () => {
		const { deps, fake } = await drafted();
		let view = updateScript("cardio", { title: `  ${"T".repeat(130)}  ` }, deps);
		assert.equal(view.title, "T".repeat(120));
		view = updateScript("cardio", { script: "  My own script.\r\nSecond line.  " }, deps);
		assert.equal(view.script, "My own script.\nSecond line.");
		assert.equal(view.chars, 27);
		assert.throws(() => updateScript("cardio", { script: "  " }, deps), refused(400, /must not be empty/));
		assert.throws(() => updateScript("cardio", { script: 5 }, deps), refused(400, /must be text/));
		assert.throws(() => updateScript("cardio", { title: 5 }, deps), refused(400, /must be text/));
		await fake.close();
	});

	it("drops the audio when the script changes, and not when only the title does", async () => {
		const { deps, fake } = await drafted();
		startAudio("cardio", deps);
		await settled(deps);
		assert.equal(updateScript("cardio", { title: "New title" }, deps).file, "summary.mp3");
		assert.equal(updateScript("cardio", { script: getAudio("cardio", deps).script }, deps).file, "summary.mp3", "the same text is no change");
		const view = updateScript("cardio", { script: "Different words." }, deps);
		assert.equal(view.file, null);
		assert.equal(deps.audio.fileOf("cardio", "summary.mp3"), null);
		await fake.close();
	});

	it("needs a script to change, and waits for a run", async () => {
		const { deps, addJob, fake } = await setup();
		assert.throws(() => updateScript("cardio", { script: "x" }, deps), refused(400, /no script to change yet/));
		startScript("cardio", { jobIds: [addJob("Lecture", { 1: "words" })] }, deps);
		assert.throws(() => updateScript("cardio", { title: "x" }, deps), refused(409, /please wait/));
		await settled(deps);
		await fake.close();
	});
});

describe("making the audio", () => {
	async function drafted(options: Options = {}) {
		const s = await setup(options);
		startScript("cardio", { jobIds: [s.addJob("Lecture", { 1: "words" })] }, s.deps);
		await settled(s.deps);
		return s;
	}

	it("needs a script and a key — and asks ElevenLabs for nothing before that", async () => {
		const { deps, fake, addJob } = await setup();
		assert.throws(() => startAudio("cardio", deps), refused(400, /Write a script first/));
		startScript("cardio", { jobIds: [addJob("Lecture", { 1: "words" })] }, deps);
		await settled(deps);
		deps.apiKey = () => "";
		assert.throws(() => startAudio("cardio", deps), refused(400, /No ElevenLabs API key/));
		assert.equal(fake.requests.length, 0);
		await fake.close();
	});

	it("makes the MP3 of the current script with the key and the voice, and keeps it", async () => {
		const { deps, fake } = await drafted();
		const script = getAudio("cardio", deps).script;
		assert.equal(startAudio("cardio", deps), true);
		assert.equal(startAudio("cardio", deps), false, "a run is going already");
		const view = await settled(deps);

		assert.equal(view.file, "summary.mp3");
		assert.equal(view.audioError, "");
		assert.equal(view.status, "draft");
		assert.equal(fake.requests.length, 1);
		assert.equal(fake.requests[0]!.key, KEY);
		assert.equal(fake.requests[0]!.voice, view.defaultVoiceId);
		assert.equal(fake.requests[0]!.body.text, script);
		const { file, size } = audioFile("cardio", deps);
		assert.equal(size, SILENT_FRAME.length * framesFor(script));
		assert.equal(fs.readFileSync(file).length, size);
		await fake.close();
	});

	it("uses the voice the learner chose, and goes back to the default", async () => {
		const { deps, fake } = await drafted();
		assert.equal(setVoice("  AbC_123-x ", deps), "AbC_123-x");
		startAudio("cardio", deps);
		await settled(deps);
		assert.equal(fake.requests[0]!.voice, "AbC_123-x");
		assert.equal(setVoice("", deps), getAudio("cardio", deps).defaultVoiceId);
		assert.equal(setVoice(null, deps), getAudio("cardio", deps).defaultVoiceId);
		assert.throws(() => setVoice("../x", deps), refused(400, /not valid/));
		assert.throws(() => setVoice(7, deps), refused(400, /must be text/));
		await fake.close();
	});

	it("cuts a script the service finds too long, and joins the pieces", async () => {
		const sentences = Array.from({ length: 400 }, (_, i) => `Sentence ${i} says one thing about the heart.`);
		const { deps, fake } = await drafted({ script: () => ({ title: "Long", script: sentences.join(" ") }), maxChars: 6000 });
		startAudio("cardio", deps);
		const during = getAudio("cardio", deps);
		assert.equal(during.run?.kind, "audio");
		const view = await settled(deps);
		assert.equal(view.audioError, "");
		assert.equal(view.file, "summary.mp3");
		const [whole, ...pieces] = fake.requests;
		assert.ok([...whole!.body.text].length > 6000);
		assert.ok(pieces.length >= 2);
		assert.equal(audioFile("cardio", deps).size, pieces.reduce((n, p) => n + SILENT_FRAME.length * framesFor(p.body.text), 0));
		await fake.close();
	});

	it("keeps the script and says why when the audio fails; the next edit clears the message", async () => {
		const { deps, fake } = await drafted();
		fake.fail = { status: 401, detail: { status: "invalid_api_key", message: "Invalid API key" } };
		startAudio("cardio", deps);
		let view = await settled(deps);
		assert.match(view.audioError, /rejects the API key \(401\)/);
		assert.equal(view.file, null);
		assert.equal(view.status, "draft");
		assert.ok(view.script.length > 0);
		assert.throws(() => audioFile("cardio", deps), refused(404, /no audio yet/));

		fake.fail = null;
		view = updateScript("cardio", { script: "Fixed script." }, deps);
		assert.equal(view.audioError, "");
		startAudio("cardio", deps);
		view = await settled(deps);
		assert.equal(view.file, "summary.mp3");
		assert.equal(view.audioError, "");
		await fake.close();
	});
});
