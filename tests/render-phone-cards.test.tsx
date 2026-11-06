/**
 * The cards file in the phone app (Learnbox 2.0, Slice 10g): "Save cards file" (made on one tap, handed to the share
 * sheet on the next — the sheet only opens for a tap), "Load cards file" on the course list and on the first-run
 * screen (no Mac needed), and what each says — in a live linkedom page with the phone's source faked.
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
import type { ImportCardsResult, PreparedCardsFile } from "../components/mobile/phone-cards-file.ts";
import type { PhoneMeta } from "../components/mobile/phone-db.ts";
import type { PhoneSource } from "../components/mobile/phone-source.ts";
import type { PhoneStudyApi } from "../components/mobile/study-api.ts";
import type { StudyCourseSummary } from "../src/core/index.ts";

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
let shared: File[] = [];
let shareBehaviour: "ok" | "cancel" = "ok";

beforeEach(() => {
	store.clear();
	shared = [];
	shareBehaviour = "ok";
	setPhoneToken("KEY");
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			canShare: () => true,
			share: async (data: { files: File[] }) => {
				if (shareBehaviour === "cancel") throw new DOMException("closed", "AbortError");
				shared.push(...data.files);
			},
		},
	});
	globalThis.fetch = (async (url: unknown) =>
		String(url) === "/m-api/me" ? Response.json({ device: { id: "d1", name: "Danny's iPhone" } }) : new Response("{}", { status: 404 })) as typeof fetch;
});
afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (root) await act(async () => root!.unmount());
	host?.remove();
	root = host = undefined;
});

const $ = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const click = async (el: Element | null) => {
	assert.ok(el, "element to click is there");
	await act(async () => { (el as HTMLElement).click(); });
	await settle();
};
const pick = async (testid: string, file: File) => {
	const input = $(testid) as HTMLInputElement;
	assert.ok(input, "file input is there");
	Object.defineProperty(input, "files", { value: [file], configurable: true });
	await act(async () => {
		input.dispatchEvent(new window.Event("change", { bubbles: true }));
	});
	await settle();
};

const summary = (id: string, name: string, total = 10): StudyCourseSummary => ({ id, name, daysLeft: null, total, counts: { new: 1, learning: 0, review: 2 }, newQuota: 20 });
const META: PhoneMeta = { v: 1, deckAt: "2026-11-05T08:00:00.000Z", syncedAt: new Date(Date.now() - 5 * 60_000).toISOString(), macReviews: 0, courses: ["a"] };
function apiOf(courses: StudyCourseSummary[]): PhoneStudyApi {
	const fail = async (): Promise<never> => { throw new Error("no study call expected"); };
	return { courses: async () => courses, next: fail, answer: fail, undo: fail, weakSpots: async () => [], linkCards: async () => [], cardAction: fail } as unknown as PhoneStudyApi;
}
const prepared = (bytes = 12_345_678): PreparedCardsFile => ({ file: new File([new Uint8Array(8)], "learnbox-cards-2026-11-06-1130.lbdeck", { type: "application/octet-stream" }), cards: 10, courses: 1, media: 3, bytes });
const loaded = (over: Partial<Extract<ImportCardsResult, { kind: "ok" }>> = {}): ImportCardsResult => ({ kind: "ok", tookDeck: true, cards: 10, courses: 1, media: 2, addedReviews: 0, addedOps: 0, rejected: 0, ...over });

interface Script {
	saveCards?: PhoneSource["saveCards"];
	loadCards?: PhoneSource["loadCards"];
}
function sourceHolding(courses: StudyCourseSummary[] | null, script: Script = {}): PhoneSource {
	return {
		engine: courses ? { api: apiOf(courses), meta: META, unsent: () => 0, unsentReviews: () => [], unsentOps: () => [] } : null,
		update: async () => { throw new Error("no update expected"); },
		restore: async () => { throw new Error("no restore expected"); },
		saveCards: script.saveCards ?? (async () => null),
		loadCards: script.loadCards ?? (async () => { throw new Error("no cards file expected"); }),
	};
}
async function mount(source: PhoneSource) {
	const router = { push: () => {}, replace: () => {}, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<AppRouterContext.Provider value={router as never}><PhoneApp open={async () => source} /></AppRouterContext.Provider>));
	await settle();
}
const fileOf = (name = "learnbox-cards-2026-11-06-1130.lbdeck") => new File([new Uint8Array([1, 2, 3])], name);

describe("saving the cards file", () => {
	it("is made on one tap and handed to the share sheet on the next, with the phone's name asked for", async () => {
		let device: string | undefined;
		const made = prepared();
		await mount(sourceHolding([summary("a", "Anatomy")], { saveCards: async (d) => { device = d; return made; } }));
		assert.equal($("phone-cards-save")!.textContent, "Save cards file");
		await click($("phone-cards-save"));
		assert.equal(device, "Danny's iPhone");
		assert.deepEqual(shared, [], "nothing is shared before the second tap");
		assert.equal($("phone-cards-save"), null);
		assert.equal($("phone-cards-share")!.textContent, "Share cards file (12 MB)");
		await click($("phone-cards-share"));
		assert.deepEqual(shared, [made.file], "the very file that was made");
		assert.equal($("phone-notice")!.textContent, "Cards file handed over.");
		assert.equal($("phone-cards-save")!.textContent, "Save cards file", "and it can be made again");
	});

	it("keeps the file ready when the learner closes the share sheet", async () => {
		await mount(sourceHolding([summary("a", "Anatomy")], { saveCards: async () => prepared() }));
		await click($("phone-cards-save"));
		shareBehaviour = "cancel";
		await click($("phone-cards-share"));
		assert.equal($("phone-notice"), null);
		assert.ok($("phone-cards-share"), "tap again to share");
	});

	it("shows that it is working while the file is being made", async () => {
		let finish: (p: PreparedCardsFile) => void = () => {};
		await mount(sourceHolding([summary("a", "Anatomy")], { saveCards: () => new Promise((r) => { finish = r; }) }));
		await click($("phone-cards-save"));
		assert.equal($("phone-cards-save")!.textContent, "Preparing the file…");
		assert.equal($("phone-cards-save")!.hasAttribute("disabled"), true);
		await act(async () => finish(prepared()));
		await settle();
		assert.ok($("phone-cards-share"));
	});

	it("says so when there is nothing on the phone to save, or the file could not be made", async () => {
		await mount(sourceHolding([summary("a", "Anatomy")], { saveCards: async () => null }));
		await click($("phone-cards-save"));
		assert.equal($("phone-notice")!.textContent, "There is nothing on this phone to save yet.");
		assert.equal($("phone-cards-save")!.textContent, "Save cards file");
		await act(async () => root!.unmount());
		host?.remove();
		await mount(sourceHolding([summary("a", "Anatomy")], { saveCards: async () => { throw new Error("storage is full"); } }));
		await click($("phone-cards-save"));
		assert.equal($("phone-notice")!.textContent, "Could not make the cards file: storage is full");
	});
});

describe("loading a cards file", () => {
	it("hands the picked file to the phone's storage, shows the cards that came, and says what it did", async () => {
		let got: File | null = null;
		const after = sourceHolding([summary("a", "Anatomy"), summary("b", "Biology")]);
		await mount(sourceHolding([summary("a", "Anatomy")], { loadCards: async (f) => { got = f as File; return { result: loaded({ cards: 20, courses: 2, addedReviews: 3 }), source: after }; } }));
		const file = fileOf();
		await pick("phone-cards-load-input", file);
		assert.equal(got, file);
		assert.equal(document.querySelectorAll('[data-testid="phone-course"]').length, 2, "the courses are read again from the new source");
		assert.equal($("phone-notice")!.textContent, "Cards file loaded: 20 cards in 2 courses, 2 pictures; 3 answers to send to the Mac.");
	});

	it("explains why cards were not taken when the phone's are newer", async () => {
		await mount(sourceHolding([summary("a", "Anatomy")], { loadCards: async () => ({ result: loaded({ tookDeck: false, skipped: "phone-newer", addedOps: 1 }), source: sourceHolding([summary("a", "Anatomy")]) }) }));
		await pick("phone-cards-load-input", fileOf());
		assert.equal($("phone-notice")!.textContent, "Cards not taken: this phone already has cards that are as new or newer; 1 card change to send to the Mac.");
	});

	it("refuses a file that is not one, and says so", async () => {
		await mount(sourceHolding([summary("a", "Anatomy")], { loadCards: async () => ({ result: { kind: "not-ours" }, source: sourceHolding([summary("a", "Anatomy")]) }) }));
		await pick("phone-cards-load-input", fileOf("notes.txt"));
		assert.equal($("phone-notice")!.textContent, "This is not a Learnbox cards file.");
	});

	it("says so when the phone's storage fails while reading", async () => {
		await mount(sourceHolding([summary("a", "Anatomy")], { loadCards: async () => { throw new Error("QuotaExceededError"); } }));
		await pick("phone-cards-load-input", fileOf());
		assert.equal($("phone-notice")!.textContent, "Could not read the cards file: QuotaExceededError");
	});

	it("drops a file that was made before, since the phone has changed", async () => {
		await mount(sourceHolding([summary("a", "Anatomy")], { saveCards: async () => prepared(), loadCards: async () => ({ result: loaded(), source: sourceHolding([summary("a", "Anatomy")]) }) }));
		await click($("phone-cards-save"));
		assert.ok($("phone-cards-share"));
		await pick("phone-cards-load-input", fileOf());
		assert.ok($("phone-cards-save"), "the old file is not offered any more");
	});
});

describe("the first run without a Mac", () => {
	it("offers to load a cards file, and shows the courses once it is in", async () => {
		const after = sourceHolding([summary("a", "Anatomy")]);
		await mount(sourceHolding(null, { loadCards: async () => ({ result: loaded(), source: after }) }));
		assert.ok($("phone-setup"));
		assert.match($("phone-setup")!.textContent ?? "", /No Mac at hand\?/);
		await pick("phone-cards-load-input", fileOf());
		assert.equal($("phone-setup"), null);
		assert.equal(document.querySelectorAll('[data-testid="phone-course"]').length, 1);
		assert.match($("phone-notice")!.textContent ?? "", /^Cards file loaded: 10 cards in 1 course/);
	});

	it("stays on the first-run screen and says why when the file is no good", async () => {
		await mount(sourceHolding(null, { loadCards: async () => ({ result: { kind: "damaged" }, source: sourceHolding(null) }) }));
		await pick("phone-cards-load-input", fileOf());
		assert.ok($("phone-setup"));
		assert.match($("phone-notice")!.textContent ?? "", /cut short or damaged/);
	});
});
