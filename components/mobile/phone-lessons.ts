/**
 * Lessons from the phone (Learnbox 2.0, Slice 10f): the calls that start and list lessons on the Mac, and the adapter
 * that carries the chat session's wire (the same state machine the Mac runs, components/session-core.ts) through the
 * gateway's lesson addresses. A lesson is a chat with Claude on the Mac, so all of this needs a connection.
 */

import type { PhoneLesson } from "@/src/core";
import { phoneFetch } from "./phone-auth";
import { jsonInit, phoneJson } from "./phone-http";

/** Start a lesson for a course, optionally from cards; `text` is the learner's first message and names the lesson. Returns the chat id. */
export async function startPhoneLesson(input: { courseId: string; cardIds?: readonly string[]; text: string }): Promise<string> {
	const out = await phoneJson<{ id: string }>("/api/phone/lesson", jsonInit({ courseId: input.courseId, cardIds: input.cardIds, title: input.text }));
	return out.id;
}

/** A course's lessons on the Mac, latest first. */
export async function listPhoneLessons(courseId: string): Promise<PhoneLesson[]> {
	return (await phoneJson<{ lessons: PhoneLesson[] }>(`/api/phone/lessons?course=${encodeURIComponent(courseId)}`)).lessons;
}

const NOT_ON_PHONE = () => new Response(JSON.stringify({ error: "Not available on the phone" }), { status: 404, headers: { "Content-Type": "application/json" } });

/**
 * The session model's own addresses (`/api/chat`, `/api/chats/<id>[/stream|steer|dismiss]`, `/api/jobs?chatId=`) mapped
 * onto this lesson's gateway addresses, with the phone's key. Any other address is a 404 here: the lesson page can
 * reach nothing but its own lesson.
 */
export function lessonFetch(chatId: string, call: (url: string, init?: RequestInit) => Promise<Response> = phoneFetch): typeof fetch {
	const base = `/api/phone/lesson/${encodeURIComponent(chatId)}`;
	const wire = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? `${input.pathname}${input.search}` : input.url;
		if (url === "/api/chat") {
			let sent: unknown;
			try {
				sent = JSON.parse(String(init?.body ?? "null"));
			} catch {
				return Promise.resolve(NOT_ON_PHONE());
			}
			return call(`${base}/send`, { ...init, body: JSON.stringify({ input: (sent as { input?: unknown } | null)?.input }) });
		}
		const chat = /^\/api\/chats\/([^/?]+)(?:\/(stream|steer|dismiss))?$/.exec(url);
		if (chat && decodeURIComponent(chat[1]!) === chatId) return call(chat[2] ? `${base}/${chat[2]}` : base, init);
		if (url === `/api/jobs?chatId=${encodeURIComponent(chatId)}`) return call(`${base}/turn`, init);
		return Promise.resolve(NOT_ON_PHONE());
	};
	return wire as typeof fetch;
}

/**
 * A failure of the lesson's turn, in words for the phone. The session model hands over the Mac's answer as it came
 * (often a JSON envelope): the one the learner can act on is "no model set up yet", which only the Mac can fix.
 */
export function describeLessonError(message: string): string {
	let body: unknown;
	try {
		body = JSON.parse(message);
	} catch {
		return message;
	}
	if (typeof body !== "object" || body === null) return message;
	const { code, error } = body as { code?: unknown; error?: unknown };
	if (code === "models_not_configured") return "No model is set up on your Mac yet. Set up your models in Learnbox on the Mac, then try again.";
	return typeof error === "string" && error ? error : message;
}
