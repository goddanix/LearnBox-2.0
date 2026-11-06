import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeLessonError, lessonFetch } from "../components/mobile/phone-lessons.ts";
import { formatPhoneHash, parsePhoneHash } from "../components/mobile/phone-route.ts";
import type { PhoneRoute } from "../components/mobile/phone-route.ts";

describe("the phone's address", () => {
	it("round-trips every screen, ids with slashes, spaces and percent signs included", () => {
		const routes: PhoneRoute[] = [
			{ kind: "courses" },
			{ kind: "course", courseId: "anat" },
			{ kind: "course", courseId: "Anatomy 1/2 100%" },
			{ kind: "learn", courseId: "anat", cardIds: [] },
			{ kind: "learn", courseId: "anat", cardIds: ["c1", "crt_x_p002-c01", "a/b"] },
			{ kind: "lesson", chatId: "chat_mhx4k2_1a2b3c4d" },
			{ kind: "library" },
		];
		for (const r of routes) assert.deepEqual(parsePhoneHash(formatPhoneHash(r)), r, JSON.stringify(r));
		assert.equal(formatPhoneHash({ kind: "courses" }), "");
		assert.equal(formatPhoneHash({ kind: "library" }), "#/library");
		assert.equal(formatPhoneHash({ kind: "learn", courseId: "k", cardIds: ["a", "b"] }), "#/learn/k/a/b");
	});
	it("reads anything it does not know as the course list", () => {
		for (const h of ["", "#", "#/", "#/c", "#/c/", "#/c//x", "#/c/a/b", "#/lesson", "#/lesson/a/b", "#/library/x", "#/library/", "#/learn", "#/learn/", "#/learn//a", "#/nope/x", "#/c/%E0%A4%A", "#c/x"]) {
			assert.deepEqual(parsePhoneHash(h), { kind: "courses" }, JSON.stringify(h));
		}
	});
});

describe("the lesson page's wire", () => {
	const id = "chat_abc_12345678";
	const seen: Array<{ url: string; init?: RequestInit }> = [];
	const call = async (url: string, init?: RequestInit) => {
		seen.push({ url, init });
		return new Response("{}", { status: 200 });
	};
	const wire = lessonFetch(id, call);
	const last = () => seen.at(-1)!;

	it("sends the turn's input to the lesson's own address, the chat id out of the body", async () => {
		const signal = new AbortController().signal;
		await wire("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: id, input: { type: "text", text: "hi" } }), signal });
		assert.equal(last().url, `/api/phone/lesson/${id}/send`);
		assert.deepEqual(JSON.parse(String(last().init?.body)), { input: { type: "text", text: "hi" } });
		assert.equal(last().init?.method, "POST");
		assert.equal(last().init?.signal, signal);
	});

	it("maps the record, the stream, steer, dismiss and the running-turn check", async () => {
		for (const [from, to] of [
			[`/api/chats/${id}`, `/api/phone/lesson/${id}`],
			[`/api/chats/${id}/stream`, `/api/phone/lesson/${id}/stream`],
			[`/api/chats/${id}/steer`, `/api/phone/lesson/${id}/steer`],
			[`/api/chats/${id}/dismiss`, `/api/phone/lesson/${id}/dismiss`],
			[`/api/jobs?chatId=${id}`, `/api/phone/lesson/${id}/turn`],
		] as const) {
			await wire(from);
			assert.equal(last().url, to, from);
		}
	});

	it("reaches nothing else: another chat, another route, a body that is not JSON", async () => {
		const before = seen.length;
		for (const url of ["/api/chats/chat_other", "/api/chats/chat_other/stream", `/api/chats/${id}/settings`, `/api/chats/${id}/markdown`, "/api/chats", "/api/settings", "/api/keys", "/api/jobs?chatId=chat_other", "/api/jobs", "/api/activity/abort", `/api/chats/${id}/stream/x`]) {
			const res = await wire(url);
			assert.equal(res.status, 404, url);
		}
		assert.equal((await wire("/api/chat", { method: "POST", body: "not json {" })).status, 404);
		assert.equal(seen.length, before, "nothing was sent");
	});
});

describe("a failed turn in words", () => {
	it("says what to do when the Mac has no model set up", () => {
		const raw = JSON.stringify({ error: "No model configured — set up your models first", code: "models_not_configured", missing: ["strong"] });
		assert.match(describeLessonError(raw), /No model is set up on your Mac yet/);
	});
	it("shows the Mac's own sentence for any other envelope, and anything else as it is", () => {
		assert.equal(describeLessonError(JSON.stringify({ error: "A turn is already running", code: "busy" })), "A turn is already running");
		assert.equal(describeLessonError("The connection dropped before the turn completed."), "The connection dropped before the turn completed.");
		assert.equal(describeLessonError('{"nothing":"useful"}'), '{"nothing":"useful"}');
		assert.equal(describeLessonError("42"), "42");
		assert.equal(describeLessonError("null"), "null");
	});
});
