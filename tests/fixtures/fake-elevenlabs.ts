/**
 * A stand-in for the ElevenLabs text-to-speech API (tests never call the real, paid service). It answers
 * POST /text-to-speech/:voice with silent MP3 frames — one frame (26 ms) per 25 characters, so the length of the audio
 * follows the text — and keeps every request (voice, key header, body) for the test to look at.
 *
 *   • `maxChars`: a text longer than this is refused like ElevenLabs does (400, detail.status "max_character_limit_exceeded").
 *   • `fail`: answers with this status and detail instead (401 for a rejected key, 500 …).
 *
 * Run by hand for the browser (the app is pointed at it with LH_ELEVENLABS_BASE):
 *   node --import tsx tests/fixtures/fake-elevenlabs.ts [port] [maxChars] [failStatus]
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";

/** One silent MPEG-1 Layer III frame, 128 kbit/s, 44.1 kHz (417 bytes: the header 0xFFFB9004 and zeros). */
export const SILENT_FRAME = (() => {
	const frame = new Uint8Array(417);
	frame.set([0xff, 0xfb, 0x90, 0x04]);
	return frame;
})();

export const framesFor = (text: string): number => Math.max(1, Math.ceil([...text].length / 25));

export interface FakeRequest {
	voice: string;
	key: string | undefined;
	body: { text: string; model_id: string; previous_text?: string; next_text?: string };
}

export interface FakeElevenLabs {
	base: string;
	requests: FakeRequest[];
	maxChars: number | null;
	fail: { status: number; detail: unknown } | null;
	close(): Promise<void>;
}

export async function startFakeElevenLabs(options: { port?: number; maxChars?: number | null; onRequest?: (request: FakeRequest) => void } = {}): Promise<FakeElevenLabs> {
	const state: FakeElevenLabs = { base: "", requests: [], maxChars: options.maxChars ?? null, fail: null, close: async () => undefined };
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const match = /^\/v1\/text-to-speech\/([^/?]+)/.exec(req.url ?? "");
			if (req.method !== "POST" || !match) {
				res.writeHead(404).end();
				return;
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as FakeRequest["body"];
			state.requests.push({ voice: decodeURIComponent(match[1]!), key: req.headers["xi-api-key"] as string | undefined, body });
			options.onRequest?.(state.requests[state.requests.length - 1]!);
			const refuse = (status: number, detail: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ detail }));
			if (state.fail) return refuse(state.fail.status, state.fail.detail);
			if (state.maxChars !== null && [...body.text].length > state.maxChars) {
				return refuse(400, { status: "max_character_limit_exceeded", message: `Text exceeds the maximum of ${state.maxChars} characters.` });
			}
			const out = Buffer.concat(Array.from({ length: framesFor(body.text) }, () => Buffer.from(SILENT_FRAME)));
			res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": out.length }).end(out);
		});
	});
	await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
	state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	state.close = () =>
		new Promise((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections(); // a client keeps its connection alive: without this the server (and the test run) stays open
		});
	return state;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	const fake = await startFakeElevenLabs({
		port: Number(process.argv[2] ?? 8799),
		maxChars: process.argv[3] ? Number(process.argv[3]) : null,
		// the key itself is never printed
		onRequest: (r) => console.log(`POST voice=${r.voice} key=${r.key ? `${r.key.length} chars` : "none"} text=${[...r.body.text].length} chars prev=${r.body.previous_text ? "yes" : "no"} next=${r.body.next_text ? "yes" : "no"} model=${r.body.model_id}`),
	});
	// a fourth argument (a status such as 401) makes every request fail with it, like a rejected key
	if (process.argv[4]) fake.fail = { status: Number(process.argv[4]), detail: { status: "invalid_api_key", message: "Invalid API key" } };
	console.log(`fake ElevenLabs at ${fake.base} (max ${fake.maxChars ?? "∞"} characters)`);
}
