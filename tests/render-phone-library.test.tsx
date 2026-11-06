/**
 * Which courses the phone holds (Learnbox 2.0, Slice 10g): the folder button on the course list, the library screen
 * ("On this phone": a box per course, what leaves and what comes, Update), and the same choice on the first run — in a
 * live linkedom page with the phone's source and the Mac's list of courses faked.
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
import type { PhoneMeta } from "../components/mobile/phone-db.ts";
import { PhoneApiError } from "../components/mobile/phone-http.ts";
import type { PhoneSource, UpdateResult } from "../components/mobile/phone-source.ts";
import type { PhoneStudyApi } from "../components/mobile/study-api.ts";
import type { PhoneCatalogEntry, StudyCourseSummary } from "../src/core/index.ts";

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
let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
	store.clear();
	setPhoneToken("KEY");
	try {
		window.location.hash = "";
	} catch {
		/* no address bar */
	}
});
afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (root) await act(async () => root!.unmount());
	host?.remove();
	root = host = undefined;
});

const $ = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
const $$ = (testid: string) => [...document.querySelectorAll(`[data-testid="${testid}"]`)] as HTMLInputElement[];
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const click = async (el: Element | null) => {
	assert.ok(el, "element to click is there");
	await act(async () => { (el as HTMLElement).click(); });
	await settle();
};
const tick = (id: string) => click($$("phone-choice-item").find((i) => i.getAttribute("data-course") === id) ?? null);
const isTicked = (id: string) => ($$("phone-choice-item").find((i) => i.getAttribute("data-course") === id) as HTMLInputElement | undefined)?.checked;

const entry = (id: string, name: string, cards: number, mediaBytes = 0): PhoneCatalogEntry => ({ id, name, cards, mediaBytes });
const MAC: PhoneCatalogEntry[] = [entry("a", "Anatomy", 800, 30_000_000), entry("b", "Biology", 300, 8_000_000), entry("c", "Chemistry", 120)];
const summary = (id: string, name: string, total: number): StudyCourseSummary => ({ id, name, daysLeft: null, total, counts: { new: 1, learning: 0, review: 2 }, newQuota: 20 });
const RESULT: UpdateResult = { cards: 1100, courses: 2, reviews: 0, media: 0, mediaFailed: 0, sent: 0, sentOps: 0, newerOnMac: 0 };
const metaOf = (over: Partial<PhoneMeta> = {}): PhoneMeta => ({ v: 1, deckAt: "2026-11-05T08:00:00.000Z", syncedAt: new Date(Date.now() - 5 * 60_000).toISOString(), macReviews: 0, ...over });

type Update = (courseIds?: readonly string[]) => void;
function apiOf(courses: StudyCourseSummary[]): PhoneStudyApi {
	const fail = async (): Promise<never> => { throw new Error("no study call expected"); };
	return { courses: async () => courses, next: fail, answer: fail, undo: fail, weakSpots: async () => [], linkCards: async () => [], cardAction: fail } as unknown as PhoneStudyApi;
}
/** A source holding `held` courses; `onUpdate` hears the choice an update was asked for. */
function sourceHolding(courses: StudyCourseSummary[] | null, over: { meta?: Partial<PhoneMeta>; unsent?: number; onUpdate?: Update; fail?: Error } = {}): PhoneSource {
	return {
		engine: courses ? { api: apiOf(courses), meta: metaOf(over.meta), unsent: () => over.unsent ?? 0, unsentReviews: () => [], unsentOps: () => [] } : null,
		update: async (_progress, courseIds) => {
			over.onUpdate?.(courseIds);
			if (over.fail) throw over.fail;
			return { result: RESULT, source: sourceHolding(courses ?? [summary("a", "Anatomy", 800)], { meta: { courses: courseIds ? [...courseIds] : ["a"] } }) };
		},
		restore: async () => { throw new Error("no restore expected"); },
	};
}
/** The Mac: its phone catalog answer (or an error), and the phone's own `me`. */
function fakeMac(catalog: PhoneCatalogEntry[] | Error) {
	const asked: string[] = [];
	globalThis.fetch = (async (url: unknown) => {
		const u = String(url);
		asked.push(u);
		if (u === "/m-api/me") return Response.json({ device: { id: "d1", name: "Test iPhone" } });
		if (u === "/api/phone/catalog") {
			if (catalog instanceof Error) throw new TypeError("Failed to fetch");
			return Response.json({ v: 1, courses: catalog });
		}
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
	return asked;
}
async function mount(source: PhoneSource) {
	const router = { push: () => {}, replace: () => {}, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<AppRouterContext.Provider value={router as never}><PhoneApp open={async () => source} /></AppRouterContext.Provider>));
	await settle();
}
/** Mount a phone holding Anatomy and Biology and open the library. */
async function openLibrary(over: Parameters<typeof sourceHolding>[1] = {}) {
	await mount(sourceHolding([summary("a", "Anatomy", 800), summary("b", "Biology", 300)], { meta: { courses: ["a", "b"], catalog: MAC }, ...over }));
	await click($("phone-library-open"));
}

describe("the library: which courses this phone holds", () => {
	it("opens from the folder button and lists the Mac's courses, the held ones ticked, with their size", async () => {
		const asked = fakeMac(MAC);
		await openLibrary();
		assert.ok($("phone-library"));
		assert.ok(asked.includes("/api/phone/catalog"), "the Mac is asked for its list");
		assert.deepEqual($$("phone-choice-item").map((i) => [i.getAttribute("data-course"), i.checked]), [["a", true], ["b", true], ["c", false]]);
		const text = document.body.textContent ?? "";
		assert.match(text, /Anatomy/);
		assert.match(text, /800 cards · 30 MB/);
		assert.match(text, /120 cards/);
		assert.equal($("phone-choice-total")!.textContent, "2 courses · 1100 cards · 38 MB of pictures and sounds");
		assert.equal($("phone-library-source")!.textContent, "List from your Mac, just now.");
		assert.equal($("phone-library-apply")!.textContent, "Update now", "nothing changed yet");
	});

	it("says what leaves and what comes, and asks the update for exactly the ticked courses", async () => {
		fakeMac(MAC);
		const heard: (readonly string[] | undefined)[] = [];
		await openLibrary({ onUpdate: (ids) => heard.push(ids) });
		await tick("b");
		await tick("c");
		assert.deepEqual([isTicked("a"), isTicked("b"), isTicked("c")], [true, false, true]);
		assert.match($("phone-library-leaving")!.textContent ?? "", /Leaves this phone: Biology\./);
		assert.match($("phone-library-arriving")!.textContent ?? "", /Comes to this phone: Chemistry\./);
		assert.equal($("phone-library-apply")!.textContent, "Apply and update");
		await click($("phone-library-apply"));
		assert.deepEqual(heard, [["a", "c"]], "in the Mac's order");
		assert.equal($("phone-library"), null, "back on the course list once it worked");
		assert.ok($("phone-courses"));
		assert.match($("phone-updated")!.textContent ?? "", /^Updated: 1100 cards/);
	});

	it("tells that answers not yet sent go to the Mac first when a course leaves", async () => {
		fakeMac(MAC);
		await openLibrary({ unsent: 3 });
		assert.equal($("phone-library-leaving"), null);
		await tick("b");
		assert.match($("phone-library-leaving")!.textContent ?? "", /3 answers only on this phone go to the Mac first/);
	});

	it("keeps at least one course: with none ticked there is nothing to apply", async () => {
		fakeMac(MAC);
		await openLibrary();
		await tick("a");
		await tick("b");
		assert.ok($("phone-library-none"));
		assert.equal($("phone-library-apply")!.hasAttribute("disabled"), true);
		await tick("a");
		assert.equal($("phone-library-none"), null);
		assert.equal($("phone-library-apply")!.hasAttribute("disabled"), false);
	});

	it("stays on the screen with the reason when the update fails, and the choice is still there to try again", async () => {
		fakeMac(MAC);
		await openLibrary({ fail: new PhoneApiError("Cannot reach your Mac.", "unreachable") });
		await tick("c");
		await click($("phone-library-apply"));
		assert.ok($("phone-library"));
		assert.match($("phone-error")!.textContent ?? "", /Cannot reach your Mac/);
		assert.equal(isTicked("c"), true);
		assert.equal($("phone-library-apply")!.hasAttribute("disabled"), false);
	});

	it("uses the list from the last update when the Mac cannot be reached, and says so", async () => {
		fakeMac(new Error("down"));
		await openLibrary();
		assert.deepEqual($$("phone-choice-item").map((i) => i.getAttribute("data-course")), ["a", "b", "c"], "the list kept with the last update");
		assert.match($("phone-library-source")!.textContent ?? "", /last update/);
	});

	it("shows the courses the phone has when it has no list at all (a phone from before the choice)", async () => {
		fakeMac(new Error("down"));
		await mount(sourceHolding([summary("a", "Anatomy", 800), summary("b", "Biology", 300)]));
		await click($("phone-library-open"));
		assert.deepEqual($$("phone-choice-item").map((i) => [i.getAttribute("data-course"), i.checked]), [["a", true], ["b", true]], "it holds what it has");
	});

	it("goes back with the back button without changing anything", async () => {
		fakeMac(MAC);
		let updates = 0;
		await openLibrary({ onUpdate: () => void (updates += 1) });
		await tick("b");
		await click($("phone-library-back"));
		assert.equal(updates, 0);
		assert.ok($("phone-courses"));
	});
});

describe("the first run: which courses come", () => {
	it("offers the Mac's list with every course ticked, and gets the ones left ticked", async () => {
		fakeMac(MAC);
		const heard: (readonly string[] | undefined)[] = [];
		await mount(sourceHolding(null, { onUpdate: (ids) => heard.push(ids) }));
		assert.ok($("phone-setup"));
		assert.deepEqual($$("phone-choice-item").map((i) => i.checked), [true, true, true]);
		await tick("b");
		assert.equal($("phone-choice-total")!.textContent, "2 courses · 920 cards · 30 MB of pictures and sounds");
		await click($("phone-get-cards"));
		assert.deepEqual(heard, [["a", "c"]]);
		assert.equal($("phone-setup"), null);
	});

	it("will not get nothing", async () => {
		fakeMac(MAC);
		await mount(sourceHolding(null));
		for (const id of ["a", "b", "c"]) await tick(id);
		assert.equal($("phone-get-cards")!.hasAttribute("disabled"), true);
	});

	it("just gets everything when the Mac's list cannot be had", async () => {
		fakeMac(new Error("down"));
		const heard: (readonly string[] | undefined)[] = [];
		await mount(sourceHolding(null, { onUpdate: (ids) => heard.push(ids) }));
		assert.equal($("phone-choice"), null);
		await click($("phone-get-cards"));
		assert.deepEqual(heard, [undefined]);
	});
});
