/**
 * A thin client for the ElevenLabs text-to-speech API (ported from MedAnki's elevenlabs.py): text → MP3 bytes, and
 * `speakScript` for a whole script (one request; when the service says the text is too long, the script is cut at the ends of
 * sentences and the MP3 pieces are joined).
 *
 * The API key goes ONLY into the request header to ElevenLabs itself — no log, no other service, no Claude. The address
 * can be replaced (a test double) only by one on this machine: LH_ELEVENLABS_BASE is honoured for localhost / 127.0.0.1 / [::1].
 */

import { splitSpeech, SPEECH_PIECE } from "../../core/audio-script.ts";

export const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
/** "Rachel", one of ElevenLabs' standard voices — a sensible default, changeable in the Audio section. */
export const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
export const SPEECH_MODEL = "eleven_multilingual_v2";
/** A request may take long for a long script (MedAnki: 120 s). */
const TIMEOUT_MS = 180_000;
/** The context handed to the service with a piece of a cut script (the end of the one before, the start of the next). */
const CONTEXT_CHARS = 400;

/** `tooLong`: the service refused the text for its length (the script can be cut and sent in pieces). */
export class SpeechError extends Error {
	constructor(
		message: string,
		readonly tooLong = false,
	) {
		super(message);
		this.name = "SpeechError";
	}
}

export interface SpeechRequest {
	text: string;
	voiceId: string;
	apiKey: string;
	modelId?: string;
	/** The text before / after this piece when the script was cut (the voice carries the tone across). */
	previousText?: string;
	nextText?: string;
	signal?: AbortSignal;
}

export type Speak = (request: SpeechRequest) => Promise<Uint8Array>;

/** The address of the API: ElevenLabs, or (tests) one on this machine named by LH_ELEVENLABS_BASE. */
export function apiBase(env: Readonly<Record<string, string | undefined>> = process.env): string {
	const raw = env.LH_ELEVENLABS_BASE?.trim();
	if (!raw) return ELEVENLABS_API_BASE;
	try {
		const url = new URL(raw);
		if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return raw.replace(/\/+$/, "");
	} catch {
		// not an address: ignored
	}
	return ELEVENLABS_API_BASE;
}

/** The reason in an ElevenLabs error body ({"detail": {"status", "message"}} or {"detail": "text"}). */
function detailOf(body: string): { message: string; status: string } {
	try {
		const parsed: unknown = JSON.parse(body);
		const detail = typeof parsed === "object" && parsed !== null ? (parsed as { detail?: unknown }).detail : undefined;
		if (typeof detail === "string") return { message: detail, status: "" };
		if (typeof detail === "object" && detail !== null) {
			const d = detail as { message?: unknown; status?: unknown };
			return { message: typeof d.message === "string" ? d.message : "", status: typeof d.status === "string" ? d.status : "" };
		}
	} catch {
		// not JSON: no detail
	}
	return { message: "", status: "" };
}

const LIMIT_WORDS = /max_character_limit|text_too_long|character limit|too long|exceeds? the (?:maximum|limit)/i;

/** Text → MP3 bytes through ElevenLabs. Throws SpeechError with a message the screen can show as it is. */
export async function elevenSpeech(request: SpeechRequest, options: { fetch?: typeof fetch; base?: string } = {}): Promise<Uint8Array> {
	if (!request.apiKey) throw new SpeechError("No ElevenLabs API key is saved yet (Settings → Keys).");
	if (!request.text.trim()) throw new SpeechError("The script is empty.");
	if (!/^[A-Za-z0-9_-]+$/.test(request.voiceId)) throw new SpeechError("The voice ID is not valid (letters, digits, - and _ only).");
	const doFetch = options.fetch ?? fetch;
	const body: Record<string, string> = { text: request.text, model_id: request.modelId ?? SPEECH_MODEL };
	if (request.previousText) body.previous_text = request.previousText;
	if (request.nextText) body.next_text = request.nextText;
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	let res: Response;
	try {
		res = await doFetch(`${options.base ?? apiBase()}/text-to-speech/${encodeURIComponent(request.voiceId)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "audio/mpeg", "xi-api-key": request.apiKey },
			body: JSON.stringify(body),
			signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
		});
	} catch (err) {
		if (request.signal?.aborted) throw err;
		const why = timeout.aborted ? "it did not answer in time" : err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
		throw new SpeechError(`ElevenLabs is not reachable: ${why}`);
	}
	if (!res.ok) {
		const { message, status } = detailOf(await res.text().catch(() => ""));
		if (res.status === 401) throw new SpeechError("ElevenLabs rejects the API key (401) — please check it in the settings.");
		const tooLong = [400, 413, 422].includes(res.status) && (LIMIT_WORDS.test(status) || LIMIT_WORDS.test(message));
		throw new SpeechError(`ElevenLabs error (${res.status}): ${message || res.statusText || "no reason given"}`, tooLong);
	}
	const audio = new Uint8Array(await res.arrayBuffer());
	if (audio.length === 0) throw new SpeechError("ElevenLabs sent no audio.");
	return audio;
}

/** MP3 pieces one after the other (a stream of frames: joining the bytes is joining the audio). */
const joinBytes = (parts: readonly Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

/**
 * The whole script as one MP3. One request first (the way that worked in MedAnki); when the service refuses the text as too long,
 * the script is cut into pieces and made piece by piece. `progress(done, total)` reports the pieces (total 1 for the whole).
 */
export async function speakScript(
	script: string,
	request: Omit<SpeechRequest, "text" | "previousText" | "nextText">,
	speak: Speak,
	progress: (done: number, total: number) => void = () => undefined,
): Promise<Uint8Array> {
	progress(0, 1);
	try {
		const whole = await speak({ ...request, text: script });
		progress(1, 1);
		return whole;
	} catch (err) {
		if (!(err instanceof SpeechError) || !err.tooLong) throw err;
	}
	const pieces = splitSpeech(script, SPEECH_PIECE);
	if (pieces.length < 2) throw new SpeechError("ElevenLabs refuses the text as too long, and it cannot be cut into smaller pieces.");
	const parts: Uint8Array[] = [];
	progress(0, pieces.length);
	for (const [i, text] of pieces.entries()) {
		parts.push(
			await speak({
				...request,
				text,
				previousText: i > 0 ? pieces[i - 1]!.slice(-CONTEXT_CHARS) : undefined,
				nextText: i < pieces.length - 1 ? pieces[i + 1]!.slice(0, CONTEXT_CHARS) : undefined,
			}),
		);
		progress(i + 1, pieces.length);
	}
	return joinBytes(parts);
}
