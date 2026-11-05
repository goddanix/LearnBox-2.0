import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { LegacyImport } from "../components/create/legacy-import.tsx";
import type { MigrateResult, MigrateScan } from "../src/core/contracts.ts";

/**
 * The "From MedAnki" panel in a live page: Check lists what is there with the choices (which PDF jobs come along, into which
 * course), and Import sends exactly those choices. The server is stubbed — the real import is tests/create-migrate-server.test.ts.
 */
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (root) await act(async () => root!.unmount());
	host?.remove();
	root = host = undefined;
});

const scan = (): MigrateScan => ({
	dataDir: "/m/data",
	courses: [
		{ id: "anat", name: "Anatomy", topics: 2, alreadyImported: false, notes: 3, audio: false },
		{ id: "bio", name: "Biophysics", topics: 0, alreadyImported: false, notes: 0, audio: true },
	],
	jobs: [
		{ id: "j1", name: "Skeleton", pages: 10, cards: 40, state: "done", courseId: "anat", alreadyImported: false, linkable: 12 },
		{ id: "j2", name: "Acoustics", pages: 4, cards: 0, state: "stopped", courseId: null, alreadyImported: false, linkable: 0 },
		{ id: "j3", name: "Old one", pages: 2, cards: 5, state: "done", courseId: "bio", alreadyImported: true, linkable: 0 },
	],
	vault: { medanki: "/m/vault", medankiExists: true, current: "/home/Documents/Medizinstudium", custom: false, willSet: true },
	mcq: { dataDir: "/m/data", jobs: [{ id: "q1", name: "Quiz", pages: 3, questions: 9, alreadyImported: false, linkable: 2 }] },
});

const result = (): MigrateResult => ({ courses: 2, jobs: 1, alreadyThere: 1, drafts: 40, linked: 12, media: 3, missingMedia: 1, pictures: 40, notes: 1, audio: 1, vault: "set", mcq: { imported: 1, alreadyThere: 0, questions: 9, linked: 2 } });

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T | null;
const all = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];

async function fire(target: Element, type: string) {
	await act(async () => {
		target.dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true }));
	});
}

async function mount(onImported = () => {}) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<LegacyImport courses={[{ id: "mine", name: "Anatomy" }, { id: "own", name: "Pathology" }]} onImported={onImported} />));
}

test("Check lists the subjects, the PDF jobs with their courses, the tests and the vault — and Import sends the choices", async () => {
	const calls: { url: string; body: Record<string, unknown> }[] = [];
	globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		calls.push({ url: String(url), body });
		return Response.json(body.apply === true ? { result: result() } : { scan: scan() });
	}) as typeof fetch;
	let imported = 0;
	await mount(() => imported++);

	assert.equal(calls.length, 0, "nothing happens before Check");
	await fire(q('[data-testid="legacy-check"]')!, "click");
	assert.deepEqual(calls.map((c) => c.url), ["/api/create/migrate"]);
	assert.equal(calls[0]!.body.apply, undefined, "Check is the dry run");

	assert.deepEqual(all('[data-testid="legacy-courses"] li').map((li) => li.textContent), [
		"Anatomynew course · 2 topics · topic notes",
		"Biophysicsnew course · audio summary",
	]);
	const rows = all('[data-testid="legacy-pdf"]');
	assert.equal(rows.length, 3);
	assert.match(rows[0]!.textContent!, /Skeleton10 pages · 40 cards · 12 already study cards/);
	assert.match(rows[2]!.textContent!, /Old onealready here/);
	assert.equal(rows[2]!.querySelector("select"), null, "a job that is here has no choice");

	const select = (i: number) => rows[i]!.querySelector("select") as HTMLSelectElement;
	assert.equal(select(0).value, "anat", "MedAnki's course is preselected");
	assert.equal(select(1).value, "", "no course MedAnki knew: none");
	// MedAnki's "Anatomy" would clash with the one here: the course it makes is told apart; the others are offered too
	assert.deepEqual([...select(0).querySelectorAll("option")].map((o) => o.textContent), ["No course", "Anatomy (MedAnki)", "Biophysics", "Anatomy", "Pathology"]);
	assert.match(q('[data-testid="legacy-jobs"]')!.textContent!, /Quiz9 questions, 2 already cards/);
	assert.match(q('[data-testid="legacy-vault"]')!.textContent!, /MedAnki's Obsidian vault \(\/m\/vault\) becomes your vault/);
	assert.match(q('[data-testid="legacy-import-button"]')!.textContent!, /Import \(2 PDFs\)/);

	// the learner moves the second job to a course of their own and leaves the first one out
	([...select(1).querySelectorAll("option")].find((o) => o.value === "own") as HTMLOptionElement).selected = true; // linkedom: no select.value setter
	await fire(select(1), "change");
	assert.equal(select(1).value, "own");
	const box = rows[0]!.querySelector('input[type="checkbox"]') as HTMLInputElement;
	box.checked = false;
	await fire(box, "click");
	assert.match(q('[data-testid="legacy-import-button"]')!.textContent!, /Import \(1 PDF\)/);

	await fire(q('[data-testid="legacy-import-button"]')!, "click");
	assert.equal(calls.length, 2);
	assert.equal(calls[1]!.body.apply, true);
	assert.deepEqual(calls[1]!.body.jobs, [{ id: "j2", courseId: "own" }]);

	assert.equal(imported, 1, "the lists behind the panel are told");
	const done = q('[data-testid="legacy-done"]')!.textContent!;
	assert.match(done, /Brought over: 2 subjects, 1 PDF with 40 cards \(12 of them are study cards already\), 1 multiple-choice test with 9 questions, the topic notes of 1 subject, 1 audio summary\./);
	assert.match(done, /MedAnki's Obsidian vault is your vault now\./);
	assert.match(done, /1 picture that MedAnki no longer had could not come along\./);
	assert.match(done, /ElevenLabs key in Settings → Keys/);
	assert.equal(q('[data-testid="legacy-import-button"]'), null, "the dry run is gone: Check again for a fresh list");
});

test("a vault chosen already is told to stay, and when everything is here there is nothing to import", async () => {
	const here = scan();
	here.courses = here.courses.map((c) => ({ ...c, alreadyImported: true, notes: 0, audio: false }));
	here.jobs = here.jobs.map((j) => ({ ...j, alreadyImported: true }));
	here.mcq.jobs = here.mcq.jobs.map((j) => ({ ...j, alreadyImported: true }));
	here.vault = { ...here.vault, custom: true, willSet: false };
	globalThis.fetch = (async () => Response.json({ scan: here })) as typeof fetch;
	await mount();
	await fire(q('[data-testid="legacy-check"]')!, "click");
	assert.match(q('[data-testid="legacy-vault"]')!.textContent!, /Your Obsidian vault \(\/home\/Documents\/Medizinstudium\) stays/);
	assert.equal(q('[data-testid="legacy-import-button"]'), null);
});

test("an error from the server is shown, and a folder with nothing in it says so", async () => {
	let answer: Response = Response.json({ error: "The MedAnki data folder must be an absolute path" }, { status: 400 });
	globalThis.fetch = (async () => answer) as typeof fetch;
	await mount();
	await fire(q('[data-testid="legacy-check"]')!, "click");
	assert.match(q('[role="alert"]')!.textContent!, /absolute path/);

	const empty = scan();
	Object.assign(empty, { courses: [], jobs: [], mcq: { dataDir: "/x", jobs: [] }, vault: { ...empty.vault, medanki: null, willSet: false } });
	answer = Response.json({ scan: empty });
	await fire(q('[data-testid="legacy-check"]')!, "click");
	assert.equal(q('[role="alert"]'), null);
	assert.match(document.body.textContent!, /Nothing found there\./);
	assert.equal(q('[data-testid="legacy-import-button"]'), null);
});
