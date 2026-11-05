/**
 * The phone's review screens (Learnbox 2.0, Slices 10b–10e), in a live linkedom page with the phone's source faked:
 * the course list, a session (show answer → grade → next card, undo, done), the pairing guard, the failure
 * banners, the first-run setup, the update from the Mac, the backup file, and the card menu (pause, bury, edit).
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
import type { PhoneSource, UpdateResult } from "../components/mobile/phone-source.ts";
import type { PhoneStudyApi } from "../components/mobile/study-api.ts";
import type { PhoneCardOp, StudyCardView, StudyCourseSummary, StudyNextResult } from "../src/core/index.ts";

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
const RESULT: UpdateResult = { cards: 12, courses: 2, reviews: 0, media: 0, mediaFailed: 0, sent: 0, sentOps: 0, newerOnMac: 0 };
const OPS: PhoneCardOp[] = [{ cardId: "c1", action: "suspend", at: "2026-11-05T09:02:00.000Z" }, { cardId: "c2", action: "edit", at: "2026-11-05T09:03:00.000Z", fields: { Front: "new" } }];
const LINES = [{ cardId: "c1", at: "2026-11-05T09:00:00.000Z", grade: 3 as const }, { cardId: "c2", at: "2026-11-05T09:01:00.000Z", grade: 4 as const }];
/** A source whose engine is the scripted one; `update` is only there when a test expects it to be used. */
function sourceOf(api: PhoneStudyApi | null, extra: { unsent?: number; unsentOps?: number; update?: PhoneSource["update"]; restore?: PhoneSource["restore"] } = {}): PhoneSource {
	const lines = LINES.slice(0, extra.unsent ?? 0);
	const ops = OPS.slice(0, extra.unsentOps ?? 0);
	return {
		engine: api ? { api, meta: META, unsent: () => lines.length, unsentReviews: () => [...lines], unsentOps: () => [...ops] } : null,
		update: extra.update ?? (async () => { throw new Error("no update expected"); }),
		restore: extra.restore ?? (async () => { throw new Error("no restore expected"); }),
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
		cardAction: async (input) => {
			calls.push(`card ${input.action}`);
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
		await mount(sourceOf(fakeApi([course("a", "Anatomy")], []), { unsent: 2 }));
		assert.match($("phone-sync")!.textContent ?? "", /Cards from your Mac: 5 min ago\./);
		assert.match($("phone-unsent")!.textContent ?? "", /^2 answers only on this phone so far\.$/);
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
				return { result: { ...RESULT, media: 9, reviews: 2, sent: 3 }, source: sourceOf(next) };
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
		assert.equal($("phone-updated")!.textContent, "Updated: 12 cards, 3 answers sent to the Mac, 2 new answers from the Mac, 9 pictures.");
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
		assert.equal(updateSummary({ ...RESULT, cards: 1 }), "Updated: 1 card.");
		assert.equal(updateSummary({ ...RESULT, cards: 3, reviews: 1, media: 1, sent: 1 }), "Updated: 3 cards, 1 answer sent to the Mac, 1 new answer from the Mac, 1 picture.");
		assert.equal(updateSummary({ ...RESULT, cards: 3, media: 4, mediaFailed: 2 }), "Updated: 3 cards, 4 pictures. 2 pictures did not come; update again to retry.");
		assert.equal(updateSummary({ ...RESULT, cards: 3, sent: 2, sentOps: 1 }), "Updated: 3 cards, 2 answers sent to the Mac, 1 card change sent to the Mac.");
		assert.equal(
			updateSummary({ ...RESULT, cards: 3, sentOps: 3, newerOnMac: 2 }),
			"Updated: 3 cards, 3 card changes sent to the Mac, 2 card changes not kept: the card was changed on the Mac since.",
		);
	});
});

describe("the backup file", () => {
	const fileOf = (text: string, name = "learnbox-backup.json") => new File([text], name, { type: "application/json" });
	const pick = async (file: File) => {
		const input = $("phone-restore-input") as HTMLInputElement;
		Object.defineProperty(input, "files", { value: [file], configurable: true });
		await act(async () => {
			input.dispatchEvent(new window.Event("change", { bubbles: true }));
		});
		await settle();
	};
	let shared: File[] = [];
	beforeEach(() => {
		shared = [];
		Object.assign(globalThis.navigator ?? {}, {});
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: { canShare: () => true, share: async (data: { files: File[] }) => void shared.push(...data.files) },
		});
	});

	it("offers to save the answers only this phone has, and hands them to the share sheet with the phone's name", async () => {
		setPhoneToken("KEY");
		fakeMe("Danny's iPhone");
		await mount(sourceOf(fakeApi([course("a", "Anatomy")], []), { unsent: 2 }));
		await click($("phone-backup"));
		assert.equal(shared.length, 1);
		assert.match(shared[0]!.name, /^learnbox-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
		const saved = JSON.parse(await shared[0]!.text()) as { kind: string; device: string; reviews: unknown[] };
		assert.deepEqual([saved.kind, saved.device, saved.reviews.length], ["learnbox-phone-backup", "Danny's iPhone", 2]);
		assert.equal($("phone-notice")!.textContent, "Backup handed over.");
	});

	it("has nothing to save when the Mac has every answer", async () => {
		setPhoneToken("KEY");
		fakeMe();
		await mount(sourceOf(fakeApi([course("a", "Anatomy")], []), { unsent: 0 }));
		assert.equal($("phone-backup"), null);
		assert.ok($("phone-restore"), "reading one in is always possible");
	});

	it("asks again at the end of a session, and hands the file over from there", async () => {
		setPhoneToken("KEY");
		fakeMe();
		const script = [result("a", card("c1"), 0), result("a", null, 1, { new: 0, learning: 0, review: 0 })];
		await mount(sourceOf(fakeApi([course("a", "Anatomy")], script), { unsent: 2 }));
		await click($("phone-course"));
		await click($("phone-reveal"));
		await click($("phone-grade-3"));
		assert.match($("phone-done-unsent")!.textContent ?? "", /2 answers only on this phone\. Save a backup file now\?/);
		await click($("phone-done-backup"));
		assert.equal(shared.length, 1);
		assert.equal($("phone-done-notice")!.textContent, "Backup handed over.");
	});

	it("does not nag at the end of a session when everything is on the Mac", async () => {
		setPhoneToken("KEY");
		fakeMe();
		await mount(sourceOf(fakeApi([course("a", "Anatomy")], [result("a", null, 0, { new: 0, learning: 0, review: 0 })]), { unsent: 0 }));
		await click($("phone-course"));
		assert.ok($("phone-done"));
		assert.equal($("phone-done-unsent"), null);
	});

	it("says nothing when the learner closes the share sheet", async () => {
		setPhoneToken("KEY");
		fakeMe();
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: { canShare: () => true, share: async () => { throw new DOMException("closed", "AbortError"); } },
		});
		await mount(sourceOf(fakeApi([course("a", "Anatomy")], []), { unsent: 1 }));
		await click($("phone-backup"));
		assert.equal($("phone-notice"), null);
	});

	it("reads a picked backup file in and says how many answers were new", async () => {
		setPhoneToken("KEY");
		fakeMe();
		let got: unknown[] = [];
		const after = sourceOf(fakeApi([course("a", "Anatomy")], []), { unsent: 2 });
		await mount(
			sourceOf(fakeApi([course("a", "Anatomy")], []), {
				restore: async (backup) => {
					got = [...backup.reviews];
					return { added: 1, addedOps: 0, source: after };
				},
			}),
		);
		const file = fileOf(JSON.stringify({ v: 1, kind: "learnbox-phone-backup", createdAt: "2026-11-05T10:00:00.000Z", reviews: [...LINES, { junk: true }] }));
		await pick(file);
		assert.equal(got.length, 2);
		assert.equal($("phone-notice")!.textContent, "Backup read: 1 new answer, 1 already here, 1 unreadable skipped.");
		assert.match($("phone-unsent")!.textContent ?? "", /^2 answers only on this phone/, "the courses are read again from the new source");
	});

	it("refuses a file that is not a Learnbox phone backup, and leaves the phone alone", async () => {
		setPhoneToken("KEY");
		fakeMe();
		await mount(sourceOf(fakeApi([course("a", "Anatomy")], [])));
		for (const text of ["not json", "{}", JSON.stringify({ v: 1, kind: "other", createdAt: "x", reviews: [] })]) {
			await pick(fileOf(text));
			assert.equal($("phone-notice")!.textContent, "This is not a Learnbox phone backup file.", text);
		}
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

describe("the card menu: pause, bury, edit (Slice 10e)", () => {
	async function open(script: (StudyNextResult | Error)[], extra: Parameters<typeof sourceOf>[1] = {}) {
		setPhoneToken("KEY");
		fakeMe();
		const api = fakeApi([course("a", "Anatomy")], script);
		await mount(sourceOf(api, extra));
		await click($("phone-course"));
		return api;
	}
	const typeInto = async (testid: string, value: string) => {
		const field = $(testid) as HTMLTextAreaElement;
		await act(async () => {
			Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set?.call(field, value);
			field.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		await settle();
	};

	it("is behind one button on the card, closed until it is tapped, and not there when no card is", async () => {
		await open([result("a", card("c1"), 0)]);
		assert.equal($("phone-menu"), null);
		await click($("phone-more"));
		assert.deepEqual([$("phone-menu-edit"), $("phone-menu-bury"), $("phone-menu-suspend")].map((b) => b?.textContent), ["Edit", "Until tomorrow", "Pause card"]);
		await click($("phone-more"));
		assert.equal($("phone-menu"), null, "tapping it again closes it");
	});

	it("is not offered at the end of a session", async () => {
		await open([result("a", null, 0, { new: 0, learning: 0, review: 0 })]);
		assert.ok($("phone-done"));
		assert.equal($("phone-more"), null);
	});

	it("pauses the card with its course and step, shows the next card, and undo brings the paused one back", async () => {
		const api = await open([result("a", card("c1"), 3), result("a", card("c2"), 3), result("a", card("c1"), 3)]);
		await click($("phone-more"));
		await click($("phone-menu-suspend"));
		assert.deepEqual(api.bodies[0], { courseId: "a", cardId: "c1", action: "suspend", step: 3 });
		assert.equal(shownCard().includes("Front of c2"), true);
		assert.equal($("phone-menu"), null, "the menu closes");
		assert.equal($("phone-undo")!.hasAttribute("disabled"), false, "pausing can be taken back");
		await click($("phone-undo"));
		assert.deepEqual(api.bodies[1], { courseId: "a", cardId: "c1", action: "unsuspend", step: 3 });
		assert.equal(shownCard().includes("Front of c1"), true);
	});

	it("buries the card until tomorrow, and undo takes it back", async () => {
		const api = await open([result("a", card("c1"), 0), result("a", card("c2"), 0), result("a", card("c1"), 0)]);
		await click($("phone-more"));
		await click($("phone-menu-bury"));
		assert.equal((api.bodies[0] as { action: string }).action, "bury");
		await click($("phone-undo"));
		assert.equal((api.bodies[1] as { action: string }).action, "unbury");
		assert.deepEqual(api.calls.filter((c) => c.startsWith("card")), ["card bury", "card unbury"]);
	});

	it("undoes in order: an answer, then a pause, each its own way", async () => {
		const api = await open([result("a", card("c1"), 0), result("a", card("c2"), 1), result("a", card("c3"), 1), result("a", card("c2"), 1), result("a", card("c1"), 0)]);
		await click($("phone-reveal"));
		await click($("phone-grade-3"));
		await click($("phone-more"));
		await click($("phone-menu-suspend"));
		await click($("phone-undo"));
		await click($("phone-undo"));
		assert.deepEqual(api.calls.filter((c) => c !== "courses" && !c.startsWith("next")), ["answer", "card suspend", "card unsuspend", "undo"]);
	});

	it("opens the editor with the card's fields, keeps Save off until something changed, and sends only what changed", async () => {
		const api = await open([result("a", card("c1", { siblings: 2 }), 4), result("a", card("c1", { front: "<p>Edited</p>", back: "<p>Edited — Back of c1</p>", fields: { Front: "Edited", Back: "Back of c1" } }), 4)]);
		await click($("phone-reveal"));
		await click($("phone-more"));
		await click($("phone-menu-edit"));
		assert.ok($("phone-editor"));
		assert.equal($("phone-reveal"), null, "the card is out of the way while it is edited");
		assert.equal(($("phone-field-Front") as HTMLTextAreaElement).defaultValue, "Front of c1", "linkedom keeps the text a React textarea shows in defaultValue");
		assert.equal(($("phone-field-Back") as HTMLTextAreaElement).defaultValue, "Back of c1");
		assert.match($("phone-editor-note")!.textContent ?? "", /Also changes 2 other cards of this note\. The change goes to your Mac with the next update\./);
		assert.equal($("phone-edit-save")!.hasAttribute("disabled"), true);
		await typeInto("phone-field-Front", "Edited");
		assert.equal($("phone-edit-save")!.hasAttribute("disabled"), false);
		await click($("phone-edit-save"));
		assert.deepEqual(api.bodies[0], { courseId: "a", cardId: "c1", action: "edit", fields: { Front: "Edited" }, step: 4 });
		assert.equal($("phone-editor"), null);
		assert.equal(shownCard().includes("Edited"), true, "the edited card is on screen");
		assert.ok($("phone-grade-3"), "still the answer side, where the learner was");
		assert.equal($("phone-undo")!.hasAttribute("disabled"), true, "an edit is not undone by Undo, as on the Mac");
	});

	it("closes the editor with Cancel and sends nothing", async () => {
		const api = await open([result("a", card("c1"), 0)]);
		await click($("phone-more"));
		await click($("phone-menu-edit"));
		await typeInto("phone-field-Front", "typed and given up");
		await click($("phone-edit-cancel"));
		assert.equal($("phone-editor"), null);
		assert.deepEqual(api.calls.filter((c) => c.startsWith("card")), []);
		assert.ok($("phone-reveal"));
	});

	it("shows the engine's refusal on screen and leaves the editor open", async () => {
		const api = await open([result("a", card("c1"), 0), new PhoneApiError("Could not save your change on this phone.", "server")]);
		await click($("phone-more"));
		await click($("phone-menu-edit"));
		await typeInto("phone-field-Front", "x");
		await click($("phone-edit-save"));
		assert.match($("phone-error")!.textContent ?? "", /Could not save your change/);
		assert.ok($("phone-editor"), "the text is not lost");
		assert.equal(api.calls.filter((c) => c === "card edit").length, 1);
	});
});

describe("card changes and the backup file (Slice 10e)", () => {
	beforeEach(() => {
		Object.defineProperty(globalThis, "navigator", { configurable: true, value: { canShare: () => true, share: async (data: { files: File[] }) => void (shared = data.files) } });
	});
	let shared: File[] = [];

	it("says what only the phone has — answers and card changes — in the course list, and offers the backup for either alone", async () => {
		setPhoneToken("KEY");
		fakeMe();
		await mount(sourceOf(fakeApi([course("a", "Anatomy")], []), { unsent: 2, unsentOps: 2 }));
		assert.equal($("phone-unsent")!.textContent, "2 answers and 2 card changes only on this phone so far.");
		await act(async () => root!.unmount());
		host!.remove();
		await mount(sourceOf(fakeApi([course("a", "Anatomy")], []), { unsentOps: 1 }));
		assert.equal($("phone-unsent")!.textContent, "1 card change only on this phone so far.");
		assert.ok($("phone-backup"), "a card change alone is worth a backup");
	});

	it("puts the card changes into the file next to the answers", async () => {
		setPhoneToken("KEY");
		fakeMe();
		await mount(sourceOf(fakeApi([course("a", "Anatomy")], []), { unsent: 1, unsentOps: 2 }));
		await click($("phone-backup"));
		const saved = JSON.parse(await shared[0]!.text()) as { reviews: unknown[]; ops: PhoneCardOp[] };
		assert.equal(saved.reviews.length, 1);
		assert.deepEqual(saved.ops, OPS);
	});

	it("asks at the end of a session for both, in one sentence", async () => {
		setPhoneToken("KEY");
		fakeMe();
		await mount(sourceOf(fakeApi([course("a", "Anatomy")], [result("a", null, 0, { new: 0, learning: 0, review: 0 })]), { unsent: 1, unsentOps: 1 }));
		await click($("phone-course"));
		assert.match($("phone-done-unsent")!.textContent ?? "", /1 answer and 1 card change only on this phone\. Save a backup file now\?/);
	});

	it("reads a backup file's card changes in and says how many are waiting to be sent", async () => {
		setPhoneToken("KEY");
		fakeMe();
		let got: { reviews: readonly unknown[]; ops?: readonly PhoneCardOp[] } | null = null;
		const after = sourceOf(fakeApi([course("a", "Anatomy")], []), { unsentOps: 2 });
		await mount(
			sourceOf(fakeApi([course("a", "Anatomy")], []), {
				restore: async (backup) => {
					got = backup;
					return { added: 0, addedOps: 1, source: after };
				},
			}),
		);
		const file = new File([JSON.stringify({ v: 1, kind: "learnbox-phone-backup", createdAt: "2026-11-05T10:00:00.000Z", reviews: [], ops: OPS })], "b.json", { type: "application/json" });
		const input = $("phone-restore-input") as HTMLInputElement;
		Object.defineProperty(input, "files", { value: [file], configurable: true });
		await act(async () => {
			input.dispatchEvent(new window.Event("change", { bubbles: true }));
		});
		await settle();
		assert.deepEqual((got as { ops?: PhoneCardOp[] } | null)?.ops, OPS);
		assert.equal($("phone-notice")!.textContent, "Backup read: 0 new answers, 1 card change to send, 1 already here.");
		assert.match($("phone-unsent")!.textContent ?? "", /^2 card changes only on this phone/);
	});
});
