/**
 * Cards from a lesson (Learnbox 2.0, Slice 9c), in a live linkedom page with the server's answers faked:
 * the entry points (the lesson header's button, the graph pick's link), the form that offers a lesson's
 * statements, the job's draft list (check, edit, throw away, adopt) and the Create page opening the form
 * from the address.
 */
import { dom } from "./helpers/linkedom-page.ts";
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CreateView } from "../components/create/create-view.tsx";
import { LessonJobDetail } from "../components/create/lesson-job-detail.tsx";
import { NewLessonForm } from "../components/create/new-lesson-form.tsx";
import { NodePickerControl } from "../components/composer-actions.tsx";
import { LessonCardsButton } from "../components/lesson-cards-button.tsx";
import type { CreateJobSummary, LessonDraft, LessonJobDetail as Detail, LessonSource, LessonStatementOption } from "../src/core/index.ts";

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
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
const click = async (el: Element | null) => {
	await act(async () => { (el as HTMLElement).click(); });
	await settle();
};

async function mount(node: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(node));
	await settle();
}

/** Ticks or unticks a checkbox the way a click does: linkedom does not flip `checked` itself, and React reads the flip. */
async function toggle(box: Element | null) {
	await act(async () => {
		const input = box as HTMLInputElement;
		input.checked = !input.checked;
		input.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
	});
	await settle();
}
/** Submits a form the way Enter does (linkedom's button click does not submit). */
async function submit(form: Element | null) {
	await act(async () => {
		form!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
	});
	await settle();
}

/** Sets a field the way a person would, so React sees the change. */
async function type(el: Element | null, value: string) {
	await act(async () => {
		// the prototype's setter, not the instance's: React tracks the instance's `value` and would see no change
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
		el!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
}
async function choose(select: Element | null, value: string) {
	await act(async () => {
		const el = select as HTMLSelectElement;
		for (const option of [...el.options]) option.selected = option.value === value;
		el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
	});
}

const statement = (nodeId: string, name: string, cards = 0): LessonStatementOption => ({ nodeId, name, statement: `${name} is a true statement.`, cards });
const SOURCE: LessonSource = {
	chatId: "c1",
	title: "Wrist nerves",
	courseId: "anat",
	statements: [statement("n_median", "Median nerve"), statement("n_ulnar", "Ulnar nerve", 2), statement("n_radial", "Radial nerve")],
};
const COURSES = [{ id: "anat", name: "Anatomy" }, { id: "bio", name: "Biology" }];
const JOB: CreateJobSummary = {
	id: "crt_1",
	kind: "lesson",
	name: "Wrist nerves",
	state: "queued",
	running: false,
	createdAt: "2026-11-05T10:00:00.000Z",
	nPages: 2,
	courseId: "anat",
	chatId: "c1",
	total: 2,
	counts: { pending: 2, running: 0, done: 0, error: 0 },
	drafts: 0,
	adopted: 0,
};

interface Sent {
	url: string;
	method: string;
	body: Record<string, unknown> | null;
}
/** Answers per URL pattern (first match wins); records every request. */
function fakeServer(routes: [RegExp, (sent: Sent) => unknown][]): Sent[] {
	const sent: Sent[] = [];
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		const entry: Sent = { url, method: init?.method ?? "GET", body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null };
		sent.push(entry);
		for (const [pattern, answer] of routes) {
			if (!pattern.test(url)) continue;
			const out = answer(entry);
			return out instanceof Response ? out : Response.json(out);
		}
		return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 });
	}) as typeof fetch;
	return sent;
}

describe("the entry points", () => {
	it("the lesson header's button opens Create for this lesson when it has statements", async () => {
		fakeServer([[/^\/api\/create\/lesson-source\?chat=c1$/, () => SOURCE]]);
		await mount(<LessonCardsButton chatId="c1" />);
		const button = $("lesson-cards-button")!;
		assert.equal(button.getAttribute("href"), "/create?lesson=c1");
		assert.match(button.getAttribute("title") ?? "", /3 statements/);
		assert.match(button.textContent ?? "", /Make cards/);
	});

	it("stays grey, and says why, while the lesson has no statements yet", async () => {
		fakeServer([[/lesson-source/, () => ({ ...SOURCE, statements: [] })]]);
		await mount(<LessonCardsButton chatId="c1" />);
		const button = $("lesson-cards-button")!;
		assert.equal(button.getAttribute("href"), null);
		assert.equal(button.getAttribute("aria-disabled"), "true");
		assert.match(button.getAttribute("title") ?? "", /No statements yet/);
	});

	it("is not there at all when the server cannot say, and asks again when a turn has gone by", async () => {
		const sent = fakeServer([[/lesson-source/, () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })]]);
		await mount(<LessonCardsButton chatId="c1" refreshKey={1} />);
		assert.equal($("lesson-cards-button"), null);
		fakeServer([[/lesson-source/, () => SOURCE]]);
		await act(async () => root!.render(<LessonCardsButton chatId="c1" refreshKey={2} />));
		await settle();
		assert.ok($("lesson-cards-button"));
		assert.equal(sent.length, 1);
	});

	it("the graph pick offers 'Make cards' only with something picked and a place to go", () => {
		const html = (props: object) => renderToStaticMarkup(<NodePickerControl count={2} {...props} />);
		assert.match(html({ cardsHref: "/create?nodes=a,b" }), /<a[^>]*href="\/create\?nodes=a,b"[^>]*data-testid="practice-props-cards"|data-testid="practice-props-cards"[^>]*href="\/create\?nodes=a,b"/);
		assert.doesNotMatch(html({}), /practice-props-cards/);
		assert.doesNotMatch(renderToStaticMarkup(<NodePickerControl count={0} cardsHref="/create?nodes=" />), /practice-props-cards/);
	});
});

describe("the form", () => {
	const form = (over: Partial<React.ComponentProps<typeof NewLessonForm>> = {}) => {
		const created: CreateJobSummary[] = [];
		const node = <NewLessonForm source={SOURCE} courses={COURSES} onCreated={(j) => created.push(j)} onCancel={() => {}} {...over} />;
		return { node, created };
	};
	const boxes = () => $$("lesson-statement").map((l) => (l.querySelector("input") as HTMLInputElement).checked);

	it("ticks the statements without a card and says which ones have cards", async () => {
		await mount(form().node);
		assert.deepEqual(boxes(), [true, false, true]);
		assert.equal($$("lesson-has-cards").length, 1);
		assert.match($("lesson-has-cards")!.textContent ?? "", /Has 2 cards already/);
		assert.match($("lesson-statements")!.textContent ?? "", /2 of 3 chosen/);
		assert.equal(($("lesson-course") as HTMLSelectElement).value, "anat", "the lesson's course is preset");
		assert.equal($("new-lesson-submit")!.hasAttribute("disabled"), false);
	});

	it("needs a chosen course when the lesson has none and there are several", async () => {
		await mount(form({ source: { ...SOURCE, courseId: undefined } }).node);
		assert.equal($("new-lesson-submit")!.hasAttribute("disabled"), true);
		await choose($("lesson-course"), "bio");
		assert.equal($("new-lesson-submit")!.hasAttribute("disabled"), false);
	});

	it("takes the only course there is", async () => {
		await mount(form({ source: { ...SOURCE, courseId: undefined }, courses: [COURSES[1]!] }).node);
		assert.equal(($("lesson-course") as HTMLSelectElement).value, "bio");
		assert.equal($("new-lesson-submit")!.hasAttribute("disabled"), false);
	});

	it("cannot start with nothing ticked, and says when the lesson has no statements", async () => {
		await mount(form().node);
		await toggle($$("lesson-statement")[0]!.querySelector("input"));
		await toggle($$("lesson-statement")[2]!.querySelector("input"));
		assert.deepEqual(boxes(), [false, false, false]);
		assert.equal($("new-lesson-submit")!.hasAttribute("disabled"), true);
		await act(async () => root!.unmount());
		root = undefined;
		host?.remove();
		await mount(form({ source: { ...SOURCE, statements: [] } }).node);
		assert.ok($("lesson-no-statements"));
		assert.equal($("new-lesson-submit")!.hasAttribute("disabled"), true);
	});

	it("starts the job for exactly the ticked statements, the course and the settings", async () => {
		const sent = fakeServer([[/^\/api\/create\/jobs$/, () => ({ job: JOB })]]);
		const { node, created } = form();
		await mount(node);
		await toggle($$("lesson-statement")[1]!.querySelector("input")); // also tick the one with cards
		await submit($("new-lesson-form"));
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.method, "POST");
		assert.deepEqual(sent[0]!.body, {
			kind: "lesson",
			chatId: "c1",
			statementIds: ["n_median", "n_ulnar", "n_radial"],
			courseId: "anat",
			settings: { language: "en", maxPerStatement: 3 },
		});
		assert.deepEqual(created, [JOB]);
	});

	it("a graph pick sends the nodes instead of a lesson, and shows the server's refusal", async () => {
		const sent = fakeServer([[/jobs/, () => new Response(JSON.stringify({ error: "A statement is no longer in the lesson — reload the list" }), { status: 404 })]]);
		const { node, created } = form({ source: { ...SOURCE, chatId: undefined, title: "Graph selection" }, nodeIds: ["n_median", "n_ulnar", "n_radial"] });
		await mount(node);
		await submit($("new-lesson-form"));
		assert.deepEqual(sent[0]!.body?.nodeIds, ["n_median", "n_ulnar", "n_radial"]);
		assert.equal("chatId" in sent[0]!.body!, false);
		assert.match($("new-lesson-form")!.textContent ?? "", /no longer in the lesson/);
		assert.deepEqual(created, []);
		assert.equal($("new-lesson-submit")!.hasAttribute("disabled"), false, "the learner can try again");
	});
});

const draft = (id: string, over: Partial<LessonDraft> = {}): LessonDraft =>
	({ id, page: Number(id.slice(1, 4)), type: "basic", front: `Question ${id}`, back: `Answer ${id}`, extra: "", deleted: false, include: true, ...over }) as LessonDraft;

function detailOf(over: Partial<Detail> = {}): Detail {
	return {
		job: { ...JOB, state: "done", counts: { pending: 0, running: 0, done: 2, error: 0 }, drafts: 3 },
		settings: { model: "sonnet", language: "en", maxPerStatement: 3, concurrency: 2 },
		chatId: "c1",
		pages: [
			{ page: 1, status: "done", statement: SOURCE.statements[0]!, cards: [draft("p001-c01"), draft("p001-c02", { type: "cloze", text: "The {{c1::median nerve}} runs here." } as Partial<LessonDraft>)], note: "" },
			{ page: 2, status: "done", statement: SOURCE.statements[1]!, cards: [draft("p002-c01")], note: "" },
		],
		...over,
	};
}

describe("the job's draft list", () => {
	function server(state: { detail: Detail }, extra: [RegExp, (sent: Sent) => unknown][] = []) {
		return fakeServer([...extra, [/\/cards\//, () => ({ card: {} })], [/^\/api\/create\/jobs\/crt_1$/, () => state.detail]]);
	}
	const mountDetail = (changed: () => void = () => {}) =>
		mount(<LessonJobDetail jobId="crt_1" courses={COURSES} onBack={() => {}} onChanged={changed} />);

	it("lists each statement with its drafts, and counts what will be added", async () => {
		server({ detail: detailOf() });
		await mountDetail();
		assert.equal($$("lesson-page").length, 2);
		assert.equal($$("lesson-draft").length, 3);
		assert.match($$("lesson-page")[0]!.textContent ?? "", /Median nerve is a true statement\./);
		assert.match($$("lesson-draft")[0]!.textContent ?? "", /Question p001-c01/);
		assert.match($$("lesson-draft")[1]!.textContent ?? "", /The \{\{c1::median nerve\}\} runs here\./);
		assert.match($("adopt-button")!.textContent ?? "", /Add 3 to my cards/);
		assert.equal(($("adopt-course") as HTMLSelectElement).value, "anat", "the job's course");
		assert.match($("job-progress")!.textContent ?? "", /Finished\. 2 of 2 statements · 3 drafts/);
	});

	it("unselecting and throwing away are saved, and shrink what will be added", async () => {
		const state = { detail: detailOf() };
		const sent = server(state);
		await mountDetail();
		state.detail.pages[0]!.cards[0] = draft("p001-c01", { include: false });
		await toggle($$("lesson-draft")[0]!.querySelector("input"));
		assert.deepEqual(sent.find((s) => s.method === "PATCH"), { url: "/api/create/jobs/crt_1/cards/p001-c01", method: "PATCH", body: { include: false } });
		assert.match($("adopt-button")!.textContent ?? "", /Add 2 to my cards/);

		state.detail.pages[1]!.cards[0] = draft("p002-c01", { deleted: true });
		await click(document.querySelector('[data-testid="lesson-draft"] button[aria-label="Throw away"]'));
		assert.match($("adopt-button")!.textContent ?? "", /Add 1 to my cards/);
	});

	it("edits a draft in place and saves only on Save", async () => {
		const state = { detail: detailOf() };
		const sent = server(state);
		await mountDetail();
		await click(document.querySelector('[data-testid="lesson-draft"] button[aria-label="Edit"]'));
		assert.ok($("lesson-draft-edit"));
		await type($("lesson-edit-front"), "A better question?");
		assert.equal(sent.filter((s) => s.method === "PATCH").length, 0, "nothing is sent while typing");
		state.detail.pages[0]!.cards[0] = draft("p001-c01", { front: "A better question?" } as Partial<LessonDraft>);
		await click($("lesson-edit-save"));
		assert.deepEqual(sent.find((s) => s.method === "PATCH")!.body, { front: "A better question?", back: "Answer p001-c01", extra: "" });
		assert.equal($("lesson-draft-edit"), null);
		assert.match($$("lesson-draft")[0]!.textContent ?? "", /A better question\?/);
	});

	it("a cloze draft edits its text with the gaps, not a question and an answer", async () => {
		const sent = server({ detail: detailOf() });
		await mountDetail();
		await click($$("lesson-draft")[1]!.querySelector('button[aria-label="Edit"]'));
		assert.ok($("lesson-edit-text"));
		assert.equal($("lesson-edit-front"), null);
		assert.equal($("lesson-edit-back"), null);
		await click($("lesson-edit-save"));
		assert.deepEqual(sent.find((s) => s.method === "PATCH")!.body, { text: "The {{c1::median nerve}} runs here.", extra: "" });
	});

	it("adds the selected drafts to the chosen course and says how many", async () => {
		const state = { detail: detailOf() };
		const changed: number[] = [];
		const sent = server(state, [[/\/adopt$/, () => ({ adopted: 3, skipped: 0 })]]);
		await mountDetail(() => changed.push(1));
		await choose($("adopt-course"), "bio");
		await click($("adopt-button"));
		const adopt = sent.find((s) => s.url.endsWith("/adopt"))!;
		assert.deepEqual(adopt.body, { courseId: "bio", cardIds: ["p001-c01", "p001-c02", "p002-c01"] });
		assert.equal($("adopt-note")!.textContent, "3 cards added to your core knowledge.");
		assert.ok(changed.length > 0, "the job list is told");
	});

	it("shows adopted drafts as cards without controls, a failed statement with a retry, and why a statement has no card", async () => {
		const state = {
			detail: detailOf({
				pages: [
					{ page: 1, status: "done", statement: SOURCE.statements[0]!, cards: [draft("p001-c01", { adopted: { courseId: "anat", cardId: "x", at: "" } })], note: "" },
					{ page: 2, status: "error", error: "model hiccup", statement: SOURCE.statements[1]!, cards: [], note: "" },
					{ page: 3, status: "done", statement: SOURCE.statements[2]!, cards: [], note: "Too vague to ask." },
				],
			}),
		};
		const sent = server(state, [[/\/start$/, () => ({ started: true })]]);
		await mountDetail();
		const first = $$("lesson-draft")[0]!;
		assert.match(first.textContent ?? "", /In your cards/);
		assert.equal(first.querySelector("input"), null);
		assert.equal(first.querySelector("button"), null);
		assert.match($$("lesson-page")[1]!.textContent ?? "", /failed — model hiccup/);
		assert.match($("lesson-no-cards")!.textContent ?? "", /Too vague to ask\./);
		assert.match($("adopt-button")!.textContent ?? "", /Add 0 to my cards/);
		assert.equal($("adopt-button")!.hasAttribute("disabled"), true);
		const retry = [...$$("lesson-page")[1]!.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
		await click(retry);
		assert.deepEqual(sent.find((s) => s.url.endsWith("/start"))!.body, { pages: [2] });
	});

	it("shows a running job with a Stop, polls it, and tells a paused one apart", async () => {
		const running = detailOf({ job: { ...JOB, state: "running", running: true, counts: { pending: 1, running: 1, done: 0, error: 0 } } });
		server({ detail: running });
		await mountDetail();
		assert.ok($("job-stop"));
		assert.equal($("job-resume"), null);
		assert.match($("job-progress")!.textContent ?? "", /Working…/);
		await act(async () => root!.unmount());
		root = undefined;
		host?.remove();
		server({ detail: detailOf({ job: { ...JOB, state: "stopped", counts: { pending: 1, running: 0, done: 1, error: 0 } } }) });
		await mountDetail();
		assert.ok($("job-resume"));
		assert.match($("job-progress")!.textContent ?? "", /Paused\./);
	});
});

describe("the Create page", () => {
	const CREATE_COURSES = [{ id: "anat", name: "Anatomy", topics: [], strict: false, jobs: 0, drafts: 0 }];
	const world = (made: { jobs: CreateJobSummary[] }) =>
		[
			[/^\/api\/library$/, () => ({ sources: [] })],
			[/^\/api\/create\/jobs$/, (s: Sent) => (s.method === "POST" ? (made.jobs.push(JOB), { job: JOB }) : { jobs: made.jobs })],
			[/^\/api\/create\/courses$/, () => ({ courses: CREATE_COURSES })],
			[/^\/api\/create\/lesson-source\?chat=c1$/, () => SOURCE],
			[/^\/api\/create\/lesson-source\?nodes=n_a%2Cn_b$/, () => ({ ...SOURCE, chatId: undefined, title: "Graph selection" })],
			[/^\/api\/create\/jobs\/crt_1$/, () => detailOf()],
		] as [RegExp, (sent: Sent) => unknown][];

	it("opens the form for the lesson named in the address, and stays quiet without one", async () => {
		const sent = fakeServer(world({ jobs: [] }));
		await mount(<CreateView />);
		assert.equal($("new-lesson-form"), null);
		assert.equal(sent.some((s) => s.url.includes("lesson-source")), false);
		await act(async () => root!.unmount());
		root = undefined;
		host?.remove();

		fakeServer(world({ jobs: [] }));
		await mount(<CreateView lesson="c1" />);
		assert.ok($("new-lesson-form"));
		assert.match($("new-lesson-form")!.textContent ?? "", /Flashcards from Wrist nerves/);
	});

	it("opens the form for nodes picked on the graph", async () => {
		fakeServer(world({ jobs: [] }));
		await mount(<CreateView nodes={["n_a", "n_b"]} />);
		assert.match($("new-lesson-form")!.textContent ?? "", /Flashcards from Graph selection/);
	});

	it("shows the refusal when the lesson is unknown, and no form", async () => {
		fakeServer([[/lesson-source/, () => new Response(JSON.stringify({ error: "Unknown lesson" }), { status: 404 })], ...world({ jobs: [] })]);
		await mount(<CreateView lesson="gone" />);
		assert.equal($("new-lesson-form"), null);
		assert.match(document.body.textContent ?? "", /Unknown lesson/);
	});

	it("goes from the form to the job's draft list, and labels the lesson job in the list", async () => {
		fakeServer(world({ jobs: [] }));
		await mount(<CreateView lesson="c1" />);
		assert.equal(($("lesson-course") as HTMLSelectElement).value, "anat");
		await submit($("new-lesson-form"));
		assert.equal($("new-lesson-form"), null, "the form is done with");
		assert.ok($("lesson-job-detail"));
		assert.equal($$("lesson-draft").length, 3);

		await click([...document.querySelectorAll("button")].find((b) => /Back/.test(b.textContent ?? "")) ?? null);
		assert.match($("create-job")!.textContent ?? "", /Wrist nerves/);
		assert.match($("create-job")!.textContent ?? "", /Lesson cards/);
		assert.match($("create-job")!.textContent ?? "", /0 of 2 statements/);
	});
});
