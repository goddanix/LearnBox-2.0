/**
 * The Study screen's links to lessons (Learnbox 2.0, Slice 9b), in a live linkedom page with the
 * server's answers faked: the weak-spot list on the start page, the way from a card to a lesson
 * (button and key L), the lessons listed on a card, and the way from a lesson back to a card
 * (`initialCourseId` / `initialCardId`, and the links of the context card).
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { StudyContextCard } from "../components/study-context-card.tsx";
import { StudyView } from "../components/study/study-view.tsx";
import { LESSON_CARDS_MAX } from "../src/core/index.ts";
import type { ChatListItem, StudyCardView, StudyContextData, StudyCourseSummary, StudyLinkCard, StudyNextResult } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLIFrameElement: dom.window.HTMLIFrameElement,
	CustomEvent: dom.window.CustomEvent,
	Event: dom.window.Event,
	// next/link's visibility effect schedules through self.requestIdleCallback when there is no IntersectionObserver
	self: globalThis,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (root) await act(async () => root!.unmount());
	host?.remove();
	root = host = undefined;
});

const $ = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
const $$ = (testid: string) => [...document.querySelectorAll(`[data-testid="${testid}"]`)] as HTMLElement[];

const course = (id: string, name: string): StudyCourseSummary => ({ id, name, daysLeft: null, total: 5, counts: { new: 1, learning: 0, review: 2 }, newQuota: 20 });
const weakCard = (id: string, lapses: number): StudyLinkCard => ({ id, front: `Front of ${id}`, back: `Back of ${id}`, lapses });
const lesson = (id: string, title: string, over: Partial<ChatListItem> = {}): ChatListItem => ({
	id,
	title,
	kind: "teach",
	createdAt: "2026-11-01T00:00:00.000Z",
	updatedAt: "2026-11-02T00:00:00.000Z",
	messageCount: 3,
	phase: "teach",
	pendingQuestion: false,
	pendingProblem: false,
	busy: false,
	compacting: false,
	...over,
});
const cardView = (id: string): StudyCardView => ({
	id,
	kind: "basic",
	bucket: "review",
	core: false,
	front: `<p>Front of ${id}</p>`,
	back: `<p>Back of ${id}</p>`,
	fields: { Front: `Front of ${id}`, Back: `Back of ${id}` },
	siblings: 0,
	split: false,
	intervals: { 1: "1m", 2: "6m", 3: "1d", 4: "4d" },
});

interface World {
	courses?: StudyCourseSummary[];
	weak?: Record<string, StudyLinkCard[]>;
	chats?: ChatListItem[];
}

/** Answers the endpoints the screen reads; records every request URL. */
function fakeServer(world: World) {
	const urls: string[] = [];
	globalThis.fetch = (async (input: unknown) => {
		const url = String(input);
		urls.push(url);
		if (url === "/api/study/courses") return Response.json({ courses: world.courses ?? [] });
		if (url === "/api/chats") return Response.json({ chats: world.chats ?? [] });
		const weak = /^\/api\/study\/weak\?course=(.+)$/.exec(url);
		if (weak) return Response.json({ courseId: weak[1], cards: world.weak?.[decodeURIComponent(weak[1]!)] ?? [] });
		const next = /^\/api\/study\/next\?course=([^&]+)&step=0(?:&card=(.+))?$/.exec(url);
		if (next) {
			const result: StudyNextResult = {
				courseId: decodeURIComponent(next[1]!),
				counts: { new: 1, learning: 0, review: 2 },
				step: 0,
				card: cardView(next[2] ? decodeURIComponent(next[2]) : "queued"),
			};
			return Response.json(result);
		}
		return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 });
	}) as typeof fetch;
	return urls;
}

/** A router the screen can push to; Next's own useRouter reads this context. */
async function mount(node: React.ReactNode) {
	const pushed: string[] = [];
	const router = { push: (href: string) => pushed.push(href), replace: () => {}, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<AppRouterContext.Provider value={router as never}>{node}</AppRouterContext.Provider>));
	await settle();
	return pushed;
}

/** The screen reads courses, then weak spots, then lessons: let the chain of fetches finish. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });

// linkedom has no KeyboardEvent: a plain event carrying `key` is all the screen's handler reads
const press = (key: string) =>
	act(async () => {
		window.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true }), { key }));
	});
const click = async (testid: string) => { await act(async () => { $(testid)!.click(); }); await settle(); };

describe("the weak spots on the start page", () => {
	const world = (): World => ({
		courses: [course("anat", "Anatomy"), course("bio", "Biology")],
		weak: { anat: [weakCard("radial", 5), weakCard("ulnar", 3), weakCard("median", 2)] },
		chats: [lesson("c1", "Radial nerve lesson", { courseId: "anat", cardIds: ["radial"] })],
	});

	it("lists a course's weak cards behind a toggle with their count, and none for a course without any", async () => {
		fakeServer(world());
		await mount(<StudyView />);
		assert.equal($$("study-weak").length, 1, "Biology has none: no section at all");
		assert.equal($("study-weak-toggle")!.textContent, "Weak spots · 3");
		assert.equal($$("study-weak-card").length, 0, "collapsed by default");
		await click("study-weak-toggle");
		assert.deepEqual($$("study-weak-card").map((r) => r.textContent), ["Front of radial5 lapses", "Front of ulnar3 lapses", "Front of median2 lapses"]);
	});

	it("marks a weak card a lesson already covers", async () => {
		fakeServer(world());
		await mount(<StudyView />);
		await click("study-weak-toggle");
		const covered = $$("study-weak-card").map((r) => r.querySelector('[aria-label="A lesson already covers this card"]') !== null);
		assert.deepEqual(covered, [true, false, false]);
	});

	it("starts a lesson on the picked cards: a link to the draft with the course and the card ids", async () => {
		fakeServer(world());
		await mount(<StudyView />);
		await click("study-weak-toggle");
		assert.equal($("study-weak-learn"), null);
		assert.ok($("study-weak-hint"), "nothing picked: a hint, no link");
		const boxes = $$("study-weak-card").map((r) => r.querySelector("input") as HTMLInputElement);
		await act(async () => boxes[0]!.click());
		await act(async () => boxes[2]!.click());
		const link = $("study-weak-learn")!;
		assert.equal(link.textContent, "Learn about these (2)");
		assert.equal(link.getAttribute("href"), "/chat/new?course=anat&cards=radial,median");
		await act(async () => boxes[0]!.click());
		assert.equal($("study-weak-learn")!.getAttribute("href"), "/chat/new?course=anat&cards=median");
	});

	it(`takes at most ${LESSON_CARDS_MAX} cards and says so`, async () => {
		const many = Array.from({ length: LESSON_CARDS_MAX + 3 }, (_, i) => weakCard(`k${i}`, 40 - i));
		fakeServer({ courses: [course("anat", "Anatomy")], weak: { anat: many } });
		await mount(<StudyView />);
		await click("study-weak-toggle");
		const boxes = () => $$("study-weak-card").map((r) => r.querySelector("input") as HTMLInputElement);
		for (let i = 0; i < LESSON_CARDS_MAX; i++) await act(async () => boxes()[i]!.click());
		assert.equal($("study-weak-learn")!.textContent, `Learn about these (${LESSON_CARDS_MAX})`);
		assert.ok(boxes()[LESSON_CARDS_MAX]!.disabled, "the rest is off");
		assert.ok(!boxes()[0]!.disabled, "a picked card can still be taken out");
		assert.match(document.body.textContent!, new RegExp(`At most ${LESSON_CARDS_MAX} cards per lesson`));
	});

	it("still shows the courses when the weak-spot list cannot be read", async () => {
		fakeServer({ courses: [course("anat", "Anatomy")] });
		const real = globalThis.fetch;
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => (String(input).startsWith("/api/study/weak") ? new Response("{}", { status: 500 }) : real(input as string, init))) as typeof fetch;
		await mount(<StudyView />);
		assert.equal($$("study-course").length, 1);
		assert.equal($$("study-weak").length, 0);
	});
});

describe("from a card to a lesson", () => {
	const world = (): World => ({
		courses: [course("anat", "Anatomy")],
		chats: [
			lesson("c1", "Radial nerve lesson", { courseId: "anat", cardIds: ["queued", "ulnar"] }),
			lesson("c2", "Unrelated lesson", { courseId: "anat", cardIds: ["ulnar"] }),
			lesson("c3", "Moved out of the course", { cardIds: ["queued"] }),
			lesson("c4", "A practice drill", { kind: "practice", courseId: "anat", cardIds: ["queued"] }),
			// a lesson the card was MADE from (Create → cards from a lesson), tied to no course
			lesson("c5", "Made this card", { madeCardIds: ["queued", "other"] }),
			lesson("c6", "Made other cards", { madeCardIds: ["other"] }),
		],
	});
	const start = async () => {
		const urls = fakeServer(world());
		const pushed = await mount(<StudyView />);
		await click("study-course");
		return { urls, pushed };
	};

	it("opens the draft for this card with the lesson button, only once the answer is up", async () => {
		const { pushed } = await start();
		const button = () => $("study-lesson") as unknown as HTMLButtonElement;
		assert.ok(button().disabled, "front side: the learner has not seen the answer yet");
		await click("study-reveal");
		assert.ok(!button().disabled);
		await click("study-lesson");
		assert.deepEqual(pushed, ["/chat/new?course=anat&cards=queued"]);
	});

	it("does the same on L, and ignores L before the answer is up", async () => {
		const { pushed } = await start();
		await press("l");
		assert.deepEqual(pushed, [], "front side: L does nothing");
		await click("study-reveal");
		await press("L");
		assert.deepEqual(pushed, ["/chat/new?course=anat&cards=queued"]);
	});

	it("lists the lessons that started from this card or made it, once the answer is up, practice drills left out", async () => {
		await start();
		assert.equal($("study-card-lessons"), null, "front side stays clean");
		await click("study-reveal");
		assert.deepEqual($$("study-card-lesson").map((a) => [a.textContent, a.getAttribute("href")]), [
			["Radial nerve lesson", "/chat/c1"],
			["Moved out of the course", "/chat/c3"],
			["Made this card", "/chat/c5"],
		]);
	});
});

describe("from a lesson back to a card", () => {
	const world = (): World => ({ courses: [course("anat", "Anatomy"), course("bio", "Biology")] });

	it("goes straight into the course and opens the card first", async () => {
		const urls = fakeServer(world());
		await mount(<StudyView initialCourseId="anat" initialCardId="radial" />);
		assert.ok(urls.includes("/api/study/next?course=anat&step=0&card=radial"), urls.join("\n"));
		assert.match(host!.innerHTML, /<p>Front of radial<\/p>/, "the linked card is on screen (in the card frame's srcdoc)");
		assert.equal($$("study-course-card").length, 0, "inside the session, not on the list");
	});

	it("opens the course without a card when only the course is given", async () => {
		const urls = fakeServer(world());
		await mount(<StudyView initialCourseId="bio" />);
		assert.ok(urls.includes("/api/study/next?course=bio&step=0"));
	});

	it("shows the course list for a course that does not exist, and uses the link only once", async () => {
		const urls = fakeServer(world());
		await mount(<StudyView initialCourseId="gone" initialCardId="x" />);
		assert.equal($$("study-course").length, 2);
		assert.ok(!urls.some((u) => u.startsWith("/api/study/next")));

		await act(async () => root!.unmount());
		host!.remove();
		const again = fakeServer(world());
		await mount(<StudyView initialCourseId="anat" initialCardId="radial" />);
		await click("study-exit");
		assert.equal($$("study-course").length, 2, "leaving the session returns to the list");
		await click("study-course");
		const opened = again.filter((u) => u.startsWith("/api/study/next"));
		assert.deepEqual(opened, ["/api/study/next?course=anat&step=0&card=radial", "/api/study/next?course=anat&step=0"], "the second visit starts the queue, not the linked card");
	});

	it("links each card of a lesson's context card to the review screen with that card open", async () => {
		const data: StudyContextData = {
			course: { id: "anat", name: "Anatomy", topics: [], daysToExam: null },
			due: 3,
			newToday: 1,
			weak: [weakCard("w2", 4)],
			cards: [weakCard("w1", 6)],
		};
		await mount(<StudyContextCard data={data} />);
		assert.equal(document.querySelectorAll("a").length, 0, "collapsed: the cards are not on screen yet");
		await click("study-context-toggle");
		assert.deepEqual([...document.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["/study?course=anat&card=w1", "/study?course=anat&card=w2"]);
	});
});
