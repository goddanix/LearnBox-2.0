import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { apiBase, DEFAULT_VOICE_ID, elevenSpeech, ELEVENLABS_API_BASE, SpeechError, speakScript, SPEECH_MODEL, type Speak } from "../src/agent/audio/elevenlabs.ts";
import { type FakeElevenLabs, framesFor, SILENT_FRAME, startFakeElevenLabs } from "./fixtures/fake-elevenlabs.ts";

const KEY = "test-key-not-a-secret-0123456789";

describe("the ElevenLabs client", () => {
	let fake: FakeElevenLabs;
	beforeEach(async () => {
		fake = await startFakeElevenLabs();
	});
	afterEach(() => fake.close());

	it("sends the text with the key in the header and returns the MP3", async () => {
		const audio = await elevenSpeech({ text: "Hello heart.", voiceId: DEFAULT_VOICE_ID, apiKey: KEY }, { base: fake.base });
		assert.equal(audio.length, SILENT_FRAME.length * framesFor("Hello heart."));
		assert.equal(fake.requests.length, 1);
		const [req] = fake.requests;
		assert.equal(req!.voice, DEFAULT_VOICE_ID);
		assert.equal(req!.key, KEY);
		assert.deepEqual(req!.body, { text: "Hello heart.", model_id: SPEECH_MODEL });
	});

	it("refuses without a key, an empty script and a voice that is not an id — before any request", async () => {
		await assert.rejects(elevenSpeech({ text: "x", voiceId: "v", apiKey: "" }, { base: fake.base }), /No ElevenLabs API key/);
		await assert.rejects(elevenSpeech({ text: "  ", voiceId: "v", apiKey: KEY }, { base: fake.base }), /script is empty/);
		await assert.rejects(elevenSpeech({ text: "x", voiceId: "../evil", apiKey: KEY }, { base: fake.base }), /voice ID is not valid/);
		assert.equal(fake.requests.length, 0);
	});

	it("says what went wrong: a rejected key, an error with a reason, a service that is not there", async () => {
		fake.fail = { status: 401, detail: { status: "invalid_api_key", message: "Invalid API key" } };
		await assert.rejects(elevenSpeech({ text: "x", voiceId: "v", apiKey: KEY }, { base: fake.base }), /rejects the API key \(401\)/);
		fake.fail = { status: 500, detail: "The kitchen is on fire" };
		await assert.rejects(elevenSpeech({ text: "x", voiceId: "v", apiKey: KEY }, { base: fake.base }), /ElevenLabs error \(500\): The kitchen is on fire/);
		await assert.rejects(elevenSpeech({ text: "x", voiceId: "v", apiKey: KEY }, { base: "http://127.0.0.1:1/v1" }), (e) => e instanceof SpeechError && /not reachable/.test(e.message));
	});

	it("tells a text that is too long from other errors", async () => {
		fake.maxChars = 10;
		await assert.rejects(
			elevenSpeech({ text: "far more than ten characters", voiceId: "v", apiKey: KEY }, { base: fake.base }),
			(e) => e instanceof SpeechError && e.tooLong,
		);
		fake.fail = { status: 400, detail: { status: "voice_not_found", message: "no such voice" } };
		await assert.rejects(
			elevenSpeech({ text: "x", voiceId: "v", apiKey: KEY }, { base: fake.base }),
			(e) => e instanceof SpeechError && !e.tooLong,
		);
	});

	it("honours a replaced address only when it is on this machine", () => {
		assert.equal(apiBase({}), ELEVENLABS_API_BASE);
		assert.equal(apiBase({ LH_ELEVENLABS_BASE: "http://127.0.0.1:9/v1/" }), "http://127.0.0.1:9/v1");
		assert.equal(apiBase({ LH_ELEVENLABS_BASE: "http://localhost:9/v1" }), "http://localhost:9/v1");
		assert.equal(apiBase({ LH_ELEVENLABS_BASE: "https://evil.example/v1" }), ELEVENLABS_API_BASE, "the key never goes to a foreign host");
		assert.equal(apiBase({ LH_ELEVENLABS_BASE: "not an address" }), ELEVENLABS_API_BASE);
	});
});

describe("speaking a whole script", () => {
	const speakWith = (fake: FakeElevenLabs): Speak => (r) => elevenSpeech(r, { base: fake.base });
	const script = Array.from({ length: 300 }, (_, i) => `Sentence ${i} says one thing about the heart.`).join(" ");
	let fake: FakeElevenLabs;
	beforeEach(async () => {
		fake = await startFakeElevenLabs();
	});
	afterEach(() => fake.close());

	it("makes it in one request when the service takes it", async () => {
		const progress: [number, number][] = [];
		const audio = await speakScript(script, { voiceId: "v", apiKey: KEY }, speakWith(fake), (d, t) => progress.push([d, t]));
		assert.equal(fake.requests.length, 1);
		assert.equal(fake.requests[0]!.body.text, script);
		assert.equal(audio.length, SILENT_FRAME.length * framesFor(script));
		assert.deepEqual(progress, [[0, 1], [1, 1]]);
	});

	it("cuts it into pieces when the service says it is too long, with the neighbours as context", async () => {
		fake.maxChars = 5000;
		const progress: [number, number][] = [];
		const audio = await speakScript(script, { voiceId: "v", apiKey: KEY }, speakWith(fake), (d, t) => progress.push([d, t]));
		const [first, ...pieces] = fake.requests;
		assert.ok([...first!.body.text].length > 5000, "the whole script was tried first");
		assert.ok(pieces.length >= 2);
		for (const [i, p] of pieces.entries()) {
			assert.ok([...p.body.text].length <= 4500);
			assert.equal(p.body.previous_text, i > 0 ? pieces[i - 1]!.body.text.slice(-400) : undefined);
			assert.equal(p.body.next_text, i < pieces.length - 1 ? pieces[i + 1]!.body.text.slice(0, 400) : undefined);
		}
		assert.equal(pieces.map((p) => p.body.text).join(" "), script);
		assert.equal(audio.length, pieces.reduce((n, p) => n + SILENT_FRAME.length * framesFor(p.body.text), 0));
		assert.deepEqual(progress.at(-1), [pieces.length, pieces.length]);
	});

	it("does not cut for any other error", async () => {
		fake.fail = { status: 500, detail: "down" };
		await assert.rejects(speakScript(script, { voiceId: "v", apiKey: KEY }, speakWith(fake)), /ElevenLabs error \(500\)/);
		assert.equal(fake.requests.length, 1);
	});

	it("gives up honestly when a text too long cannot be cut", async () => {
		const speak: Speak = async () => {
			throw new SpeechError("too long", true);
		};
		await assert.rejects(speakScript("Short script.", { voiceId: "v", apiKey: KEY }, speak), /cannot be cut into smaller pieces/);
	});
});
