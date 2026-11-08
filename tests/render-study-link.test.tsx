/**
 * The surfaces of the study ↔ lesson links (Learnbox 2.0, Slice 9a): the context card in a lesson,
 * the course chip in its header, the course field of the draft, the start call with a course and
 * cards, the sidebar mark and the lessons under a course on the Study start page.
 *
 * Static markup where the markup is the point; a linkedom page where a click or a change is.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ComposerActions } from "../components/composer-actions.tsx";
import { DraftCourseControl } from "../components/draft-course-control.tsx";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";
import { SessionCourseChip } from "../components/session-course-chip.tsx";
import { SessionRow } from "../components/sidebar.tsx";
import { StudyContextCard } from "../components/study-context-card.tsx";
import type { ChatListItem, StudyContextData } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
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

async function mount(node: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(node));
}

const $ = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;

/** linkedom's select.value is read-only: pick the option, then fire the change React listens for. */
async function choose(testid: string, value: string) {
	const select = $(testid) as unknown as HTMLSelectElement;
	const option = [...select.options].find((o) => o.getAttribute("value") === value);
	assert.ok(option, `no option ${JSON.stringify(value)} in ${testid}`);
	await act(async () => {
		option.selected = true;
		select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
	});
}

const data = (over: Partial<StudyContextData> = {}): StudyContextData => ({
	course: { id: "anat", name: "Anatomy", topics: ["Arm", "Leg"], deadline: "2026-12-14", daysToExam: 39 },
	due: 143,
	newToday: 12,
	weak: [{ id: "w2", front: "Ulnar nerve", back: "claw hand", lapses: 4 }],
	cards: [{ id: "w1", front: "Radial nerve injury", back: "wrist drop", lapses: 1 }],
	...over,
});

describe("the study-context card", () => {
	it("is collapsed by default and names the course, the exam and the cards in one line", async () => {
		await mount(<StudyContextCard data={data()} />);
		assert.equal($("study-context-body"), null);
		assert.equal($("study-context-toggle")!.textContent, "CourseAnatomy · exam in 39 days · 1 card");
	});

	it("opens to the state, the topics, the cards the lesson started from and the weakest cards", async () => {
		await mount(<StudyContextCard data={data()} />);
		await act(async () => $("study-context-toggle")!.click());
		const body = $("study-context-body")!.textContent!;
		assert.match(body, /Anatomy — exam 2026-12-14 \(exam in 39 days\) · 143 cards due, 12 new today/);
		assert.match(body, /Topics: Arm; Leg/);
		assert.match(body, /Radial nerve injury — wrist drop · 1 lapse/);
		assert.match(body, /Ulnar nerve · 4 lapses/);
		assert.ok($("study-context-card-w1"));
		await act(async () => $("study-context-toggle")!.click());
		assert.equal($("study-context-body"), null, "a second click closes it again");
	});

	it("names the subdecks a lesson is limited to (Slice 10h), and shows no line for a whole course", async () => {
		await mount(<StudyContextCard data={data({ subdecks: ["W1 Head", ""] })} />);
		await act(async () => $("study-context-toggle")!.click());
		assert.equal($("study-context-subdecks")!.textContent, "Subdecks in this lesson: W1 Head; no subdeck");
		await act(async () => $("study-context-toggle")!.click());
		await act(async () => root!.unmount());
		host?.remove();
		await mount(<StudyContextCard data={data()} />);
		await act(async () => $("study-context-toggle")!.click());
		assert.equal($("study-context-subdecks"), null);
	});

	it("says what is missing instead of leaving gaps: no exam, no cards, a passed or a same-day exam", () => {
		const html = (d: StudyContextData) => renderToStaticMarkup(<StudyContextCard data={d} />);
		const bare = html(data({ course: { id: "a", name: "Bio", topics: [], daysToExam: null }, cards: [], weak: [] }));
		assert.match(bare, /Bio<\/span>/);
		assert.ok(!bare.includes("exam"), "no exam date, no exam words in the summary");
		assert.match(html(data({ course: { id: "a", name: "Bio", topics: [], deadline: "2026-11-05", daysToExam: 0 } })), /exam today/);
		assert.match(html(data({ course: { id: "a", name: "Bio", topics: [], deadline: "2026-11-01", daysToExam: -4 } })), /exam passed/);
		assert.equal(renderToStaticMarkup(<StudyContextCard data={undefined as never} />), "", "a marker without payload draws nothing");
	});
});

describe("the course chip in the lesson header", () => {
	const courses = [
		{ id: "anat", name: "Anatomy" },
		{ id: "bio", name: "Biology" },
	];

	function fakeFetch(opts: { putStatus?: number } = {}) {
		const calls: { url: string; method: string; body: unknown }[] = [];
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
			if (init?.method === "PUT") return new Response("{}", { status: opts.putStatus ?? 200 });
			return Response.json({ courses });
		}) as typeof fetch;
		return calls;
	}

	const change = (value: string) => choose("course-chip-select", value);

	it("lists the courses with 'No course' first and shows the one the lesson belongs to", async () => {
		fakeFetch();
		await mount(<SessionCourseChip chatId="c1" courseId="bio" />);
		const select = $("course-chip-select") as unknown as HTMLSelectElement;
		assert.deepEqual([...select.options].map((o) => o.textContent), ["No course", "Anatomy", "Biology"]);
		assert.equal(select.value, "bio");
	});

	it("renders nothing while there is no course to choose and none is set", async () => {
		globalThis.fetch = (async () => Response.json({ courses: [] })) as typeof fetch;
		await mount(<SessionCourseChip chatId="c1" courseId={null} />);
		assert.equal($("course-chip"), null);
		globalThis.fetch = (async () => Response.json({ courses: [] })) as typeof fetch;
		await act(async () => root!.unmount());
		host!.remove();
		await mount(<SessionCourseChip chatId="c1" courseId="gone" />);
		assert.ok($("course-chip"), "a set course whose record is gone still shows, so it can be taken out");
	});

	it("saves a change and takes the course out with null", async () => {
		const calls = fakeFetch();
		await mount(<SessionCourseChip chatId="c1" courseId={null} />);
		await change("anat");
		await change("");
		const puts = calls.filter((c) => c.method === "PUT");
		assert.deepEqual(puts.map((c) => c.url), ["/api/chats/c1/course", "/api/chats/c1/course"]);
		assert.deepEqual(puts.map((c) => c.body), [{ courseId: "anat" }, { courseId: null }]);
	});

	it("puts the old course back and says so when the server refuses", async () => {
		fakeFetch({ putStatus: 404 });
		await mount(<SessionCourseChip chatId="c1" courseId="bio" />);
		await change("anat");
		assert.equal(($("course-chip-select") as unknown as HTMLSelectElement).value, "bio");
		assert.match($("course-chip")!.getAttribute("title")!, /Could not change the course/);
	});
});

describe("the course field of the draft", () => {
	const courses = [
		{ id: "anat", name: "Anatomy" },
		{ id: "bio", name: "Biology" },
	];

	it("offers the courses and, for a lesson from cards, the number of cards with a way to drop them", async () => {
		let cleared = 0;
		await mount(<DraftCourseControl courses={courses} courseId="anat" cardCount={2} onCourse={() => {}} onClearCards={() => cleared++} />);
		assert.equal($("draft-cards")!.textContent, "2 cards");
		await act(async () => $("draft-cards-clear")!.click());
		assert.equal(cleared, 1);
	});

	it("shows no card mark without cards, says '1 card' for one, and reports a chosen course", async () => {
		const picked: string[] = [];
		await mount(<DraftCourseControl courses={courses} courseId="" cardCount={0} onCourse={(id) => picked.push(id)} />);
		assert.equal($("draft-cards"), null);
		assert.equal($("draft-cards-clear"), null);
		const select = $("draft-course-select") as unknown as HTMLSelectElement;
		assert.equal(select.options[0]!.textContent, "Add a course");
		await choose("draft-course-select", "bio");
		assert.deepEqual(picked, ["bio"]);
		assert.match(renderToStaticMarkup(<DraftCourseControl courses={courses} courseId="anat" cardCount={1} onCourse={() => {}} />), />1 card</);
	});

	it("sits in the composer's action row next to the other pills, and only for a teach draft", () => {
		const control = <DraftCourseControl courses={courses} courseId="" cardCount={0} onCourse={() => {}} />;
		const row = renderToStaticMarkup(<ComposerActions course={control} />);
		assert.match(row, /data-testid="composer-actions"[^>]*justify-start/);
		assert.match(row, /data-testid="draft-course"/);
		const teach = renderToStaticMarkup(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} coursePicker={control} />);
		assert.match(teach, /data-testid="draft-course"/);
		const practice = renderToStaticMarkup(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} mode="practice" coursePicker={control} />);
		assert.ok(!practice.includes('data-testid="draft-course"'), "a practice drill has no course");
	});
});

describe("startDraftSession with a course", () => {
	function fakeFetch() {
		const calls: { url: string; body: Record<string, unknown> }[] = [];
		const f = (async (url: string, init?: RequestInit) => {
			calls.push({ url: String(url), body: JSON.parse(String(init!.body)) });
			return new Response(JSON.stringify({ id: "c9" }), { status: 200 });
		}) as typeof fetch;
		return { f, calls };
	}

	it("sends the course and the card ids with the first message — ids only, the server reads the text", async () => {
		const { f, calls } = fakeFetch();
		const target = await startDraftSession("I keep getting these cards wrong.", f, undefined, undefined, { courseId: "anat", cardIds: ["a", "b"] });
		assert.equal(target, "/chat/c9?prompt=I%20keep%20getting%20these%20cards%20wrong.");
		assert.deepEqual(calls[0]!.body.study, { courseId: "anat", cardIds: ["a", "b"] });
	});

	it("sends nothing for a draft without a course, and never for a practice drill", async () => {
		const a = fakeFetch();
		await startDraftSession("hello", a.f, undefined, undefined, { courseId: "", cardIds: [] });
		assert.ok(!("study" in a.calls[0]!.body));
		const b = fakeFetch();
		await startDraftSession("drill", b.f, "practice", undefined, { courseId: "anat", cardIds: [] });
		assert.ok(!("study" in b.calls[0]!.body));
	});
});

describe("the sidebar row", () => {
	const item = (over: Partial<ChatListItem> = {}): ChatListItem => ({
		id: "c1",
		title: "Wrist drop",
		kind: "teach",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 4,
		phase: "teach",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...over,
	});

	it("marks a lesson with its course name, and shows no mark for a loose one", () => {
		const marked = renderToStaticMarkup(<SessionRow chat={item({ courseId: "anat" })} courseName="Anatomy" active={false} onOpen={() => {}} />);
		assert.match(marked, /data-testid="session-course"[^>]*>Anatomy/);
		const loose = renderToStaticMarkup(<SessionRow chat={item()} active={false} onOpen={() => {}} />);
		assert.ok(!loose.includes('data-testid="session-course"'));
	});
});
