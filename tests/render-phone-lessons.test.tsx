/**
 * The phone's lessons (Learnbox 2.0, Slice 10f), in a live linkedom page with the phone's source and the Mac faked:
 * the weak spots and lessons of a course, "Learn about this card", the start of a lesson (create, first message),
 * the lesson page (transcript, question dock, composer), and the greyed-out state without a connection.
 */
import { dom } from "./helpers/linkedom-page.ts";
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PhoneApp } from "../components/mobile/phone-app.tsx";
import { setPhoneToken } from "../components/mobile/phone-auth.ts";
import type { PhoneSource } from "../components/mobile/phone-source.ts";
import type { PhoneStudyApi } from "../components/mobile/study-api.ts";
import { suggestedFirstMessage } from "../src/core/index.ts";
import type { PhoneLesson, StudyCardView, StudyCourseSummary, StudyLinkCard, StudyNextResult } from "../src/core/index.ts";

void dom;
const store = new Map<string, string>();
Object.assign(globalThis, {
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	},
});

const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let calls: Array<{ method: string; url: string; body: unknown }> = [];

const setOnline = (online: boolean) => Object.defineProperty(globalThis, "navigator", { value: { onLine: online }, configurable: true, writable: true });
beforeEach(() => {
	store.clear();
	setPhoneToken("KEY");
	calls = [];
	setOnline(true);
});
afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
	if (root) await act(async () => root!.unmount());
	host?.remove();
	root = host = undefined;
});

const $ = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
const $$ = (testid: string) => [...document.querySelectorAll(`[data-testid="${testid}"]`)] as HTMLElement[];
const text = (testid: string) => $(testid)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
const click = async (el: Element | null) => {
	assert.ok(el, "element to click is there");
	await act(async () => { (el as HTMLElement).click(); });
	await settle();
};
/** Type into a React text field (its value setter lives on the prototype, which React watches). */
const type = async (el: HTMLElement | null, value: string) => {
	assert.ok(el, "field to type into is there");
	await act(async () => {
		const proto = Object.getPrototypeOf(el) as object;
		Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
		el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
};

const META = { v: 1 as const, deckAt: "2026-11-05T08:00:00.000Z", syncedAt: new Date(Date.now() - 5 * 60_000).toISOString(), macReviews: 0 };
const course = (id: string, name: string): StudyCourseSummary => ({ id, name, daysLeft: null, total: 10, counts: { new: 3, learning: 1, review: 4 }, newQuota: 20 });
const card = (id: string): StudyCardView => ({
	id, kind: "basic", bucket: "new", core: false, front: `<p>Front of ${id}</p>`, back: `<p>Back of ${id}</p>`,
	fields: { Front: `Front of ${id}`, Back: `Back of ${id}` }, siblings: 0, split: false, intervals: { 1: "1m", 2: "6m", 3: "10m", 4: "3d" },
});
const WEAK: StudyLinkCard[] = [
	{ id: "w1", front: "Which nerve runs behind the medial epicondyle?", back: "Ulnar", lapses: 3 },
	{ id: "w2", front: "Which muscle abducts the thumb?", back: "Abductor pollicis longus", lapses: 2 },
];

/** A scripted engine: one course, the given weak spots, one card to review. */
function api(over: Partial<PhoneStudyApi> = {}): PhoneStudyApi {
	const next = (): StudyNextResult => ({ courseId: "a", counts: { new: 1, learning: 0, review: 0 }, step: 0, card: card("c1") });
	return {
		courses: async () => [course("a", "Anatomy")],
		next: async () => next(),
		answer: async () => next(),
		undo: async () => next(),
		weakSpots: async () => WEAK,
		linkCards: async (_c, ids) => WEAK.filter((w) => ids.includes(w.id)),
		cardAction: async () => next(),
		...over,
	};
}
const sourceOf = (a: PhoneStudyApi, meta: typeof META & { topics?: Record<string, string[]> } = META): PhoneSource => ({
	engine: { api: a, meta, unsent: () => 0, unsentReviews: () => [], unsentOps: () => [] },
	update: async () => { throw new Error("no update expected"); },
	restore: async () => { throw new Error("no restore expected"); },
		saveCards: async () => null,
		loadCards: async () => { throw new Error("no cards file expected"); },
});
async function mount(a: PhoneStudyApi, meta?: Parameters<typeof sourceOf>[1]) {
	const router = { push: () => {}, replace: () => {}, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<AppRouterContext.Provider value={router as never}><PhoneApp open={async () => sourceOf(a, meta)} /></AppRouterContext.Provider>));
	await settle();
}

type Handler = (body: unknown) => Response | Promise<Response>;
/** The Mac, as far as the phone talks to it: a table of "METHOD /path" → answer; every call is recorded. */
function mac(table: Record<string, Handler>) {
	globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		const path = String(url);
		let body: unknown = undefined;
		try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init?.body; }
		calls.push({ method, url: path, body });
		const handler = table[`${method} ${path}`];
		return handler ? handler(body) : new Response(JSON.stringify({ error: `no route ${method} ${path}` }), { status: 404 });
	}) as typeof fetch;
}
const sse = (...events: unknown[]) => new Response(events.map((e) => (e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`)).join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
const ME = { "GET /m-api/me": () => Response.json({ device: { id: "d1", name: "Test iPhone" } }) };
const LESSONS: PhoneLesson[] = [
	{ id: "chat_l1", title: "Why the ulnar nerve?", updatedAt: "2026-11-05T10:00:00.000Z", busy: false, pendingQuestion: true },
	{ id: "chat_l2", title: "Thumb muscles", updatedAt: "2026-11-04T10:00:00.000Z", busy: true, pendingQuestion: false },
];
const assistant = (id: string, blocks: unknown[], stopReason = "stop") => ({ id, role: "assistant", content: blocks, stopReason, usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 }, timestamp: 1, provider: "p", model: "m" });
const user = (id: string, content: string) => ({ id, role: "user", content, timestamp: 1 });
const record = (id: string, messages: unknown[], over: Record<string, unknown> = {}) => ({ id, title: "A lesson", messages, turnInFlight: false, ...over });

describe("a course's weak spots on the phone", () => {
	it("lists them from the phone's own answers, picks up to a lesson, and opens the start of the lesson", async () => {
		mac({ ...ME, "GET /api/phone/lessons?course=a": () => Response.json({ lessons: [] }) });
		await mount(api());
		assert.match(text("phone-weak-toggle"), /Weak spots · 2/);
		assert.equal($$("phone-weak-card").length, 0, "closed until opened");
		await click($("phone-weak-toggle"));
		assert.equal($$("phone-weak-card").length, 2);
		assert.equal(($("phone-weak-learn") as HTMLButtonElement).disabled, true, "nothing picked yet");
		assert.match(text("phone-weak-hint"), /Pick cards/);
		await click($$("phone-weak-card")[0]!.querySelector("input"));
		assert.equal(($("phone-weak-learn") as HTMLButtonElement).disabled, false);
		assert.match(text("phone-weak-learn"), /Learn about these \(1\)/);
		await click($("phone-weak-learn"));
		assert.equal(text("phone-lesson-start-about"), "A lesson about this card");
		assert.equal(($("phone-lesson-start-text") as HTMLTextAreaElement).defaultValue, suggestedFirstMessage(1));
		assert.match(text("phone-lesson-start-cards"), /Which nerve runs behind the medial epicondyle\?\s*Ulnar/);
	});

	it("shows no list for a course with none", async () => {
		mac({ ...ME });
		await mount(api({ weakSpots: async () => [] }));
		assert.equal($("phone-weak"), null);
	});

	it("is grey without a connection and says why — the list itself is still there", async () => {
		setOnline(false);
		mac({ ...ME });
		await mount(api());
		await click($("phone-weak-toggle"));
		await click($$("phone-weak-card")[0]!.querySelector("input"));
		assert.equal(($("phone-weak-learn") as HTMLButtonElement).disabled, true);
		assert.match(text("phone-weak-hint"), /Needs a connection to your Mac/);
		assert.equal($$("phone-lessons").length, 0);
		assert.ok(!calls.some((c) => c.url.startsWith("/api/phone/lessons")), "the Mac is not asked while offline");
	});
});

describe("a course's lessons on the phone", () => {
	it("lists them from the Mac, latest first, and opens one", async () => {
		mac({
			...ME,
			"GET /api/phone/lessons?course=a": () => Response.json({ lessons: LESSONS }),
			"GET /api/phone/lesson/chat_l1": () => Response.json(record("chat_l1", [user("u1", "Why the ulnar nerve?"), assistant("a1", [{ type: "text", text: "Because it runs behind the epicondyle." }])], { title: "Why the ulnar nerve?" })),
			"GET /api/phone/lesson/chat_l1/stream": () => sse({ type: "turn-settled" }, "[DONE]"),
		});
		await mount(api());
		assert.deepEqual($$("phone-lesson").map((l) => l.textContent), ["Why the ulnar nerve?question waiting", "Thumb muscles" + "writing…"]);
		await click($$("phone-lesson")[0]!);
		assert.equal(text("phone-lesson-title"), "Why the ulnar nerve?");
		assert.match(text("phone-lesson-transcript"), /Why the ulnar nerve\?/);
		assert.match(text("phone-lesson-transcript"), /Because it runs behind the epicondyle/);
		assert.equal($("phone-lesson-text") !== null, true, "no question waiting: the composer is there");
	});

	it("folds a long list behind '+N more'", async () => {
		const many = Array.from({ length: 7 }, (_, i) => ({ ...LESSONS[0]!, id: `chat_${i}`, title: `Lesson ${i}`, pendingQuestion: false }));
		mac({ ...ME, "GET /api/phone/lessons?course=a": () => Response.json({ lessons: many }) });
		await mount(api());
		assert.equal($$("phone-lesson").length, 5);
		assert.equal(text("phone-lessons-more"), "+2 more");
		await click($("phone-lessons-more"));
		assert.equal($$("phone-lesson").length, 7);
	});

	it("shows none when the Mac cannot be asked", async () => {
		mac({ ...ME });
		await mount(api());
		assert.equal($("phone-lessons"), null);
	});
});

describe("Learn about this card", () => {
	const openMenu = async () => {
		await click($$("phone-course")[0]!);
		await click($("phone-more"));
	};
	it("sits in the card menu and opens the start of a lesson about that card", async () => {
		mac({ ...ME });
		await mount(api({ weakSpots: async () => [], linkCards: async () => [{ id: "c1", front: "Front of c1", back: "Back of c1", lapses: 0 }] }));
		await openMenu();
		assert.equal(($("phone-menu-learn") as HTMLButtonElement).disabled, false);
		assert.equal($("phone-menu-learn-hint"), null);
		await click($("phone-menu-learn"));
		assert.equal(text("phone-lesson-start-about"), "A lesson about this card");
		assert.match(text("phone-lesson-start-cards"), /Front of c1\s*Back of c1/);
		assert.equal(($("phone-lesson-start-text") as HTMLTextAreaElement).defaultValue, suggestedFirstMessage(1));
	});

	it("is grey offline, with the reason", async () => {
		setOnline(false);
		mac({ ...ME });
		await mount(api({ weakSpots: async () => [] }));
		await openMenu();
		assert.equal(($("phone-menu-learn") as HTMLButtonElement).disabled, true);
		assert.match(text("phone-menu-learn-hint"), /Needs a connection to your Mac/);
	});
});

describe("starting a lesson", () => {
	const toStart = async () => {
		await click($("phone-weak-toggle"));
		await click($$("phone-weak-card")[0]!.querySelector("input"));
		await click($("phone-weak-learn"));
	};

	it("creates it on the Mac with the course, the cards and the learner's first message, then sends that message as turn 1", async () => {
		mac({
			...ME,
			"POST /api/phone/lesson": () => Response.json({ id: "chat_new", title: "x" }),
			"GET /api/phone/lesson/chat_new": () => Response.json(record("chat_new", [{ id: "m0", role: "custom", customType: "study-context", content: "ctx", display: true, details: null, timestamp: 1 }])),
			"POST /api/phone/lesson/chat_new/send": () => Response.json({ ok: true }),
			"GET /api/phone/lesson/chat_new/stream": () => sse({ type: "turn-settled" }, "[DONE]"),
		});
		await mount(api());
		await toStart();
		await type($("phone-lesson-start-text"), "Why does it run there?");
		await click($("phone-lesson-start-go"));
		const create = calls.find((c) => c.method === "POST" && c.url === "/api/phone/lesson");
		assert.deepEqual(create?.body, { courseId: "a", cardIds: ["w1"], title: "Why does it run there?" });
		assert.ok($("phone-lesson"), "the lesson page is up");
		const send = calls.find((c) => c.url === "/api/phone/lesson/chat_new/send");
		assert.deepEqual(send?.body, { input: { type: "text", text: "Why does it run there?" } });
		assert.equal(calls.filter((c) => c.url === "/api/phone/lesson/chat_new/send").length, 1, "once");
	});

	it("limits the lesson to the subdecks of a course the phone holds in part (Slice 10h) — and says nothing of subdecks for a course held whole", async () => {
		const table = {
			...ME,
			"POST /api/phone/lesson": () => Response.json({ id: "chat_new", title: "x" }),
			"GET /api/phone/lesson/chat_new": () => Response.json(record("chat_new", [])),
			"POST /api/phone/lesson/chat_new/send": () => Response.json({ ok: true }),
			"GET /api/phone/lesson/chat_new/stream": () => sse({ type: "turn-settled" }, "[DONE]"),
		};
		mac(table);
		await mount(api(), { ...META, topics: { a: ["W1 Head", ""] } });
		await toStart();
		await type($("phone-lesson-start-text"), "Why?");
		await click($("phone-lesson-start-go"));
		assert.deepEqual(calls.find((c) => c.url === "/api/phone/lesson")?.body, { courseId: "a", cardIds: ["w1"], topics: ["W1 Head", ""], title: "Why?" });
		await act(async () => root!.unmount());
		host?.remove();
		calls.length = 0;
		mac(table);
		await mount(api(), { ...META, topics: { other: ["x"] } });
		await toStart();
		await type($("phone-lesson-start-text"), "Why?");
		await click($("phone-lesson-start-go"));
		assert.deepEqual(calls.find((c) => c.url === "/api/phone/lesson")?.body, { courseId: "a", cardIds: ["w1"], title: "Why?" }, "a course not held in part sends no subdecks");
	});

	it("says what went wrong and stays at the start when the Mac refuses", async () => {
		mac({ ...ME, "POST /api/phone/lesson": () => new Response(JSON.stringify({ error: "Unknown card" }), { status: 404 }) });
		await mount(api());
		await toStart();
		await click($("phone-lesson-start-go"));
		assert.equal(text("phone-lesson-start-error"), "Unknown card");
		assert.ok($("phone-lesson-start"), "still at the start");
		assert.equal(($("phone-lesson-start-go") as HTMLButtonElement).disabled, false, "may try again");
	});

	it("says the Mac cannot be reached when the call fails", async () => {
		globalThis.fetch = (async (url: unknown) => { if (String(url) === "/api/phone/lesson") throw new TypeError("Failed to fetch"); return new Response("{}", { status: 404 }); }) as typeof fetch;
		await mount(api());
		await toStart();
		await click($("phone-lesson-start-go"));
		assert.match(text("phone-lesson-start-error"), /Cannot reach your Mac/);
	});

	it("does not start with nothing to say, nor without a connection", async () => {
		mac({ ...ME });
		await mount(api());
		await toStart();
		await type($("phone-lesson-start-text"), "   ");
		assert.equal(($("phone-lesson-start-go") as HTMLButtonElement).disabled, true);
		assert.ok(!calls.some((c) => c.url === "/api/phone/lesson"));
	});
});

describe("the lesson page", () => {
	const open = async (rec: unknown, extra: Record<string, Handler> = {}) => {
		mac({
			...ME,
			"GET /api/phone/lessons?course=a": () => Response.json({ lessons: [LESSONS[0]!] }),
			"GET /api/phone/lesson/chat_l1": () => Response.json(rec),
			"GET /api/phone/lesson/chat_l1/stream": () => sse({ type: "turn-settled" }, "[DONE]"),
			...extra,
		});
		await mount(api({ weakSpots: async () => [] }));
		await click($$("phone-lesson")[0]!);
	};

	it("opens a question that waits in the same dock as on the Mac, in place of the composer", async () => {
		await open(record("chat_l1", [user("u1", "teach me"), assistant("a1", [{ type: "text", text: "Think about the elbow." }, { type: "toolCall", id: "call1", name: "ask_user_question", arguments: { question: "Which nerve passes there?" } }], "toolUse")]));
		assert.match(text("phone-lesson-transcript"), /Think about the elbow/);
		assert.ok($("phone-lesson-dock"), "the dock is up");
		assert.match(text("phone-lesson-dock"), /Which nerve passes there\?/);
		assert.equal($("phone-lesson-text"), null, "no composer while a question waits");
	});

	it("sends what the learner writes, to this lesson only, and clears the field", async () => {
		// the Mac writes the message down before it answers: the record read afterwards has it
		const messages: unknown[] = [user("u1", "teach me"), assistant("a1", [{ type: "text", text: "Ask away." }])];
		await open(null, {
			"GET /api/phone/lesson/chat_l1": () => Response.json(record("chat_l1", messages)),
			"POST /api/phone/lesson/chat_l1/send": (body) => {
				messages.push(user("u2", (body as { input: { text: string } }).input.text));
				return Response.json({ ok: true });
			},
		});
		assert.equal(($("phone-lesson-send") as HTMLButtonElement).disabled, true, "nothing written yet");
		await type($("phone-lesson-text"), "And the median nerve?");
		await click($("phone-lesson-send"));
		const sent = calls.find((c) => c.url === "/api/phone/lesson/chat_l1/send");
		assert.deepEqual(sent?.body, { input: { type: "text", text: "And the median nerve?" } });
		assert.match(text("phone-lesson-transcript"), /And the median nerve\?/);
		assert.ok(calls.every((c) => c.url.startsWith("/api/phone/") || c.url === "/m-api/me"), "only the phone's own addresses");
	});

	it("shows the failure and a way to try again when the lesson cannot be read", async () => {
		await open(null, { "GET /api/phone/lesson/chat_l1": () => new Response(JSON.stringify({ error: "Unknown lesson" }), { status: 404 }) });
		assert.equal(text("phone-lesson-error").replace("Retry", "").trim(), "Unknown lesson");
		assert.ok($("phone-lesson-retry"));
	});

	it("leaves for the course list", async () => {
		await open(record("chat_l1", [user("u1", "hi"), assistant("a1", [{ type: "text", text: "Hello." }])]));
		await click($("phone-lesson-exit"));
		assert.ok($("phone-courses"));
	});
});
