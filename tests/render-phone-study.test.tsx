/**
 * The phone's review screens (Learnbox 2.0, Slices 10b/10c), in a live linkedom page with the phone's source faked:
 * the course list, a session (show answer → grade → next card, undo, done), the pairing guard, the failure
 * banners, the first-run setup and the update from the Mac.
 */
import { dom } from "./helpers/linkedom-page.ts";
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PhoneApp, updateSummary } from "../components/mobile/phone-app.tsx";
import { setPhoneToken } from "../components/mobile/phone-auth.ts";
import { PhoneApiError } from "../components/mobile/phone-http.ts";
import type { PhoneSource } from "../components/mobile/phone-source.ts";
import type { PullResult } from "../components/mobile/pull-deck.ts";
import type { PhoneStudyApi } from "../components/mobile/study-api.ts";
import type { StudyCardView, StudyCourseSummary, StudyNextResult } from "../src/core/index.ts";

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
let replaced: string[] = [];

beforeEach(() => {
	store.clear();
	replaced = [];
});
afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (root) await act(async () => root!.unmount());
	host?.remove();
	root = host = undefined;
});

const $ = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
const $$ = (testid: string) => [...document.querySelectorAll(`[data-testid="${testid}"]`)] as HTMLElement[];
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const click = async (el: Element | null) => {
	assert.ok(el, "element to click is there");
	await act(async () => { (el as HTMLElement).click(); });
	await settle();
};
async function mount(source: PhoneSource | PhoneStudyApi) {
	const open = async () => ("update" in source ? source : sourceOf(source));
	const router = { push: () => {}, replace: (href: string) => replaced.push(href), back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<AppRouterContext.Provider value={router as never}><PhoneApp open={open} /></AppRouterContext.Provider>));
	await settle();
}
const META = { v: 1 as const, deckAt: "2026-11-05T08:00:00.000Z", syncedAt: new Date(Date.now() - 5 * 60_000).toISOString(), macReviews: 0 };
const RESULT: PullResult = { cards: 12, courses: 2, reviews: 0, media: 0, mediaFailed: 0 };
/** A source whose engine is the scripted one; `update` is only there when a test expects it to be used. */
function sourceOf(api: PhoneStudyApi | null, extra: { unsent?: number; update?: PhoneSource["update"] } = {}): PhoneSource {
	return {
		engine: api ? { api, meta: META, unsent: () => extra.unsent ?? 0 } : null,
		update: extra.update ?? (async () => { throw new Error("no update expected"); }),
	};
}
/** The phone's own `me` answer, so the paired name shows; everything else the screens ask goes to the fake engine. */
const fakeMe = (name = "Test iPhone") => {
	globalThis.fetch = (async (url: unknown) =>
		String(url) === "/m-api/me" ? Response.json({ device: { id: "d1", name } }) : new Response("{}", { status: 404 })) as typeof fetch;
};

/** The HTML the card iframe shows right now. */
const shownCard = (): string => {
	const frame = document.querySelector("iframe") as (HTMLIFrameElement & { srcDoc?: string }) | null;
	return frame?.getAttribute("srcdoc") ?? frame?.getAttribute("srcDoc") ?? frame?.srcDoc ?? "";
};

const course = (id: string, name: string, over: Partial<StudyCourseSummary> = {}): StudyCourseSummary => ({
	id,
	name,
	daysLeft: null,
	total: 10,
	counts: { new: 3, learning: 1, review: 4 },
	newQuota: 20,
	...over,
});
const card = (id: string, over: Partial<StudyCardView> = {}): StudyCardView => ({
	id,
	kind: "basic",
	bucket: "new",
	core: false,
	front: `<p>Front of ${id}</p>`,
	back: `<p>Back of ${id}</p>`,
	fields: { Front: `Front of ${id}`, Back: `Back of ${id}` },
	siblings: 0,
	split: false,
	intervals: { 1: "1m", 2: "6m", 3: "10m", 4: "3d" },
	...over,
});
const result = (courseId: string, c: StudyCardView | null, step: number, counts = { new: 2, learning: 1, review: 4 }): StudyNextResult => ({ courseId, counts, step, card: c });

/** A scripted engine: `next` and every answer/undo get the next prepared result; every call is recorded. */
function fakeApi(courses: StudyCourseSummary[], script: (StudyNextResult | Error)[]): PhoneStudyApi & { calls: string[]; bodies: unknown[] } {
	const calls: string[] = [];
	const bodies: unknown[] = [];
	const take = (): StudyNextResult => {
		const out = script.shift();
		if (!out) throw new Error("script ran out");
		if (out instanceof Error) throw out;
		return out;
	};
	return {
		calls,
		bodies,
		courses: async () => {
			calls.push("courses");
			return courses;
		},
		next: async (courseId, step, open) => {
			calls.push(`next ${courseId} ${step}${open ? ` ${open}` : ""}`);
			return take();
		},
		answer: async (input) => {
			calls.push("answer");
			bodies.push(input);
			return take();
		},
		undo: async (input) => {
			calls.push("undo");
			bodies.push(input);
			return take();
		},
	};
}

describe("the pairing guard", () => {
	it("sends a phone without a key to the pairing page and shows nothing", async () => {
		const api = fakeApi([course("a", "Anatomy")], []);
		await mount(api);
		assert.deepEqual(replaced, ["/m/pair"]);
		assert.equal($("phone-courses"), null);
		assert.deepEqual(api.calls, [], "no study call without a key");
	});

	it("sends it there too when the Mac says the key is gone while updating", async () => {
		setPhoneToken("KEY");
		fakeMe();
		await mount(sourceOf(fakeApi([course("a", "Anatomy")], []), { update: async () => { throw new PhoneApiError("This phone is not paired (any more).", "unpaired"); } }));
		assert.deepEqual(replaced, [], "studying works without asking the Mac");
		await click($("phone-update"));
		assert.deepEqual(replaced, ["/m/pair"]);
	});
});

describe("the course list", () => {
	it("lists the courses with their counts and the exam countdown, and names the phone", async () => {
		setPhoneToken("KEY");
		fakeMe("Danny's iPhone");
		await mount(fakeApi([course("a", "Anatomy", { daysLeft: 39 }), course("b", "Biochemistry", { total: 1, daysLeft: 1, counts: { new: 0, learning: 0, review: 0 } })], []));
		const rows = $$("phone-course");
		assert.equal(rows.length, 2);
		assert.match(rows[0]!.textContent ?? "", /Anatomy/);
		assert.match(rows[0]!.textContent ?? "", /10 cards · exam in 39 days/);
		assert.match(rows[0]!.textContent ?? "", /314/, "new, learning, due");
		assert.match(rows[1]!.textContent ?? "", /1 cards · exam in 1 day$|exam in 1 day(?!s)/);
		assert.match($("phone-courses")!.textContent ?? "", /Danny's iPhone/);
	});

	it("says so when there is nothing to study", async () => {
		setPhoneToken("KEY");
		fakeMe();
		await mount(fakeApi([], []));
		assert.ok($("phone-empty"));
	});

	it("shows when the cards came from the Mac, and how many answers only this phone has", async () => {
		setPhoneToken("KEY");
		fakeMe();
		await mount(sourceOf(fakeApi([course("a", "Anatomy")], []), { unsent: 3 }));
		assert.match($("phone-sync")!.textContent ?? "", /Cards from your Mac: 5 min ago\./);
		assert.match($("phone-unsent")!.textContent ?? "", /^3 answers only on this phone so far\.$/);
		await act(async () => root!.unmount());
		host!.remove();
		await mount(sourceOf(fakeApi([course("a", "Anatomy")], []), { unsent: 1 }));
		assert.match($("phone-unsent")!.textContent ?? "", /^1 answer only/);
		await act(async () => root!.unmount());
		host!.remove();
		await mount(fakeApi([course("a", "Anatomy")], []));
		assert.equal($("phone-unsent"), null, "nothing to say when everything is on the Mac");
	});
});

describe("updating from the Mac", () => {
	it("shows the progress, then what came, and reads the courses again from the new deck", async () => {
		setPhoneToken("KEY");
		fakeMe();
		const next = fakeApi([course("a", "Anatomy"), course("b", "Biochemistry")], []);
		let finish!: () => void;
		const gate = new Promise<void>((r) => (finish = r));
		const first = sourceOf(fakeApi([course("a", "Anatomy")], []), {
			update: async (onProgress) => {
				onProgress({ phase: "media", done: 2, total: 9 });
				await gate;
				return { result: { ...RESULT, media: 9, reviews: 2 }, source: sourceOf(next) };
			},
		});
		await mount(first);
		assert.equal($$("phone-course").length, 1);
		await click($("phone-update"));
		assert.match($("phone-sync")!.textContent ?? "", /Getting pictures… 2 \/ 9/);
		assert.equal($("phone-update")!.hasAttribute("disabled"), true, "one update at a time");
		await act(async () => finish());
		await settle();
		assert.equal($$("phone-course").length, 2);
		assert.equal($("phone-updated")!.textContent, "Updated: 12 cards, 2 new answers from the Mac, 9 pictures.");
		assert.equal($("phone-update")!.hasAttribute("disabled"), false);
		assert.ok(next.calls.includes("courses"));
	});

	it("keeps the old deck and says why when the Mac cannot be reached", async () => {
		setPhoneToken("KEY");
		fakeMe();
		const api = fakeApi([course("a", "Anatomy")], []);
		await mount(sourceOf(api, { update: async () => { throw new PhoneApiError("Cannot reach your Mac.", "unreachable"); } }));
		await click($("phone-update"));
		assert.match($("phone-error")!.textContent ?? "", /Cannot reach your Mac/);
		assert.equal($$("phone-course").length, 1, "the cards on the phone are still there");
		assert.deepEqual(replaced, [], "unreachable is not unpaired");
		assert.equal($("phone-updated"), null);
	});

	it("says what an update did, in a sentence", () => {
		assert.equal(updateSummary({ cards: 1, courses: 1, reviews: 0, media: 0, mediaFailed: 0 }), "Updated: 1 card.");
		assert.equal(updateSummary({ cards: 3, courses: 1, reviews: 1, media: 1, mediaFailed: 0 }), "Updated: 3 cards, 1 new answer from the Mac, 1 picture.");
		assert.equal(updateSummary({ cards: 3, courses: 1, reviews: 0, media: 4, mediaFailed: 2 }), "Updated: 3 cards, 4 pictures. 2 pictures did not come; update again to retry.");
	});
});

describe("the first run", () => {
	it("asks for the cards when the phone has none, and shows the courses once they are in", async () => {
		setPhoneToken("KEY");
		fakeMe();
		let updates = 0;
		await mount(
			sourceOf(null, {
				update: async (onProgress) => {
					updates += 1;
					onProgress({ phase: "deck", done: 1, total: 1 });
					return { result: RESULT, source: sourceOf(fakeApi([course("a", "Anatomy")], [])) };
				},
			}),
		);
		assert.ok($("phone-setup"));
		assert.equal($("phone-courses"), null);
		await click($("phone-get-cards"));
		assert.equal(updates, 1);
		assert.equal($("phone-setup"), null);
		assert.equal($$("phone-course").length, 1);
	});

	it("stays on the setup screen with the reason when the Mac cannot be reached", async () => {
		setPhoneToken("KEY");
		fakeMe();
		await mount(sourceOf(null, { update: async () => { throw new PhoneApiError("Cannot reach your Mac.", "unreachable"); } }));
		await click($("phone-get-cards"));
		assert.ok($("phone-setup"));
		assert.match($("phone-error")!.textContent ?? "", /Cannot reach your Mac/);
		assert.equal($("phone-get-cards")!.hasAttribute("disabled"), false, "it can be tried again");
	});

	it("says so when the phone cannot keep cards at all", async () => {
		setPhoneToken("KEY");
		fakeMe();
		const router = { push: () => {}, replace: () => {}, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () => root!.render(<AppRouterContext.Provider value={router as never}><PhoneApp open={async () => { throw new Error("This browser cannot keep cards on the phone."); }} /></AppRouterContext.Provider>));
		await settle();
		assert.match($("phone-error")!.textContent ?? "", /cannot keep cards/);
	});
});

describe("a session", () => {
	async function open(script: (StudyNextResult | Error)[]) {
		setPhoneToken("KEY");
		fakeMe();
		const api = fakeApi([course("a", "Anatomy")], script);
		await mount(api);
		await click($("phone-course"));
		return api;
	}

	it("starts at step 0, shows the front, and reveals the answer buttons with their intervals", async () => {
		const api = await open([result("a", card("c1"), 0)]);
		assert.deepEqual(api.calls.filter((c) => c.startsWith("next")), ["next a 0"]);
		assert.ok($("phone-session"));
		assert.equal($("phone-grade-1"), null, "grades only after the answer is up");
		assert.equal(shownCard().includes("Front of c1"), true);
		await click($("phone-reveal"));
		assert.deepEqual([1, 2, 3, 4].map((g) => $(`phone-grade-${g}`)!.textContent), ["1mAgain", "6mHard", "10mGood", "3dEasy"]);
		assert.equal(shownCard().includes("Back of c1"), true);
		assert.equal($("phone-reveal"), null);
	});

	it("sends the grade with the card, the course, the time and the step, then shows the next card front side up", async () => {
		const api = await open([result("a", card("c1"), 0), result("a", card("c2"), 1, { new: 1, learning: 1, review: 4 })]);
		await click($("phone-reveal"));
		await click($("phone-grade-3"));
		const sent = api.bodies[0] as Record<string, unknown>;
		assert.deepEqual({ courseId: sent.courseId, cardId: sent.cardId, grade: sent.grade, step: sent.step }, { courseId: "a", cardId: "c1", grade: 3, step: 0 });
		assert.equal(typeof sent.ms, "number");
		assert.equal(shownCard().includes("Front of c2"), true);
		assert.ok($("phone-reveal"), "front side again");
		assert.match($("phone-session-counts")!.textContent ?? "", /114/);
	});

	it("takes the latest answer back: the card is shown again at its step", async () => {
		const api = await open([result("a", card("c1"), 0), result("a", card("c2"), 1), result("a", card("c1"), 0)]);
		assert.equal($("phone-undo")!.hasAttribute("disabled"), true, "nothing to undo yet");
		await click($("phone-reveal"));
		await click($("phone-grade-2"));
		assert.equal($("phone-undo")!.hasAttribute("disabled"), false);
		await click($("phone-undo"));
		assert.deepEqual(api.bodies[1], { courseId: "a", cardId: "c1", step: 0 });
		assert.equal(shownCard().includes("Front of c1"), true);
		assert.equal($("phone-undo")!.hasAttribute("disabled"), true);
	});

	it("is done when no card is left, counts the answers, and goes back to a refreshed list", async () => {
		const api = await open([result("a", card("c1"), 0), result("a", null, 1, { new: 0, learning: 0, review: 0 })]);
		await click($("phone-reveal"));
		await click($("phone-grade-4"));
		assert.match($("phone-done")!.textContent ?? "", /Done for today\.1 card answered\./);
		const before = api.calls.filter((c) => c === "courses").length;
		await click($("phone-done-back"));
		assert.ok($("phone-courses"));
		assert.equal(api.calls.filter((c) => c === "courses").length, before + 1);
	});

	it("shows a failed answer in a banner and keeps the card", async () => {
		await open([result("a", card("c1"), 0), new PhoneApiError("Cannot reach your Mac.", "unreachable")]);
		await click($("phone-reveal"));
		await click($("phone-grade-3"));
		assert.match($("phone-error")!.textContent ?? "", /Cannot reach your Mac/);
		assert.ok($("phone-grade-3"), "still on the same card, answers up");
		assert.equal($("phone-retry"), null, "retry is for a session that never started");
	});

	it("offers Retry when the first card cannot be fetched", async () => {
		const api = await open([new PhoneApiError("Cannot reach your Mac.", "unreachable"), result("a", card("c1"), 0)]);
		assert.match($("phone-error")!.textContent ?? "", /Cannot reach your Mac/);
		await click($("phone-retry"));
		assert.equal($("phone-error"), null);
		assert.ok($("phone-reveal"));
		assert.deepEqual(api.calls.filter((c) => c.startsWith("next")), ["next a 0", "next a 0"]);
	});

	it("goes to the pairing page when the key is dropped mid-session", async () => {
		await open([result("a", card("c1"), 0), new PhoneApiError("This phone is not paired (any more).", "unpaired")]);
		await click($("phone-reveal"));
		await click($("phone-grade-3"));
		assert.deepEqual(replaced, ["/m/pair"]);
	});

	it("labels an MCQ's button Check", async () => {
		await open([result("a", card("m1", { kind: "mcq", fields: { Q: "q", Answers: "A" } }), 0)]);
		assert.match($("phone-reveal")!.textContent ?? "", /Check/);
	});
});
