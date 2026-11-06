/**
 * Staying paired and knowing the copy is safe (Learnbox 2.0, Slice 10g): the key kept in two places, the pairing page
 * that never asks a paired phone for a code, the home-screen nudge, and the storage line.
 */
import { dom } from "./helpers/linkedom-page.ts";
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PairForm } from "../components/mobile/pair-form.tsx";
import { PhoneApp } from "../components/mobile/phone-app.tsx";
import { storageLine } from "../components/mobile/phone-courses.tsx";
import { clearPhoneToken, getPhoneToken, restorePhoneToken, setPhoneToken, useKeyVault } from "../components/mobile/phone-auth.ts";
import type { KeyVault } from "../components/mobile/phone-auth.ts";
import { formatBytes, requestPersistentStorage } from "../components/mobile/phone-storage.ts";
import type { PhoneSource } from "../components/mobile/phone-source.ts";
import type { PhoneStudyApi } from "../components/mobile/study-api.ts";
import type { StudyCourseSummary } from "../src/core/index.ts";

void dom;
const local = new Map<string, string>();
Object.assign(globalThis, {
	localStorage: {
		getItem: (k: string) => local.get(k) ?? null,
		setItem: (k: string, v: string) => void local.set(k, v),
		removeItem: (k: string) => void local.delete(k),
	},
});

/** The second copy of the key, in memory. */
function memoryVault(): KeyVault & { held: () => string | null } {
	let held: string | null = null;
	return {
		held: () => held,
		read: async () => held,
		write: async (t) => void (held = t),
		remove: async () => void (held = null),
	};
}

const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let replaced: string[] = [];
let vault = memoryVault();

beforeEach(() => {
	local.clear();
	replaced = [];
	vault = memoryVault();
	useKeyVault(vault);
	Object.defineProperty(globalThis.navigator, "standalone", { value: false, configurable: true });
});
afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (root) await act(async () => root!.unmount());
	host?.remove();
	root = host = undefined;
});

const $ = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const router = () => ({ push: () => {}, replace: (href: string) => replaced.push(href), back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} });
async function mount(node: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<AppRouterContext.Provider value={router() as never}>{node}</AppRouterContext.Provider>));
	await settle();
}
/** The Mac's answer to "is my key still good?"; any other request is not expected. */
const macSays = (status: number | "unreachable") => {
	const asked: string[] = [];
	globalThis.fetch = (async (url: unknown) => {
		asked.push(String(url));
		if (status === "unreachable") throw new TypeError("Failed to fetch");
		return status === 200 ? Response.json({ device: { id: "d1", name: "My iPhone" } }) : new Response("{}", { status });
	}) as typeof fetch;
	return asked;
};

describe("the phone's key is kept in two places", () => {
	it("goes into both, and out of both", async () => {
		setPhoneToken("KEY");
		assert.equal(getPhoneToken(), "KEY");
		await settle();
		assert.equal(vault.held(), "KEY");
		clearPhoneToken();
		await settle();
		assert.equal(getPhoneToken(), null);
		assert.equal(vault.held(), null);
	});

	it("comes back from the second copy when localStorage was emptied, and is then read as before", async () => {
		setPhoneToken("KEY");
		await settle();
		local.clear();
		assert.equal(getPhoneToken(), null);
		assert.equal(await restorePhoneToken(), "KEY");
		assert.equal(getPhoneToken(), "KEY");
	});

	it("is put into the second copy by a phone that was paired before it existed", async () => {
		local.set("lh-phone-token", "OLD");
		assert.equal(await restorePhoneToken(), "OLD");
		await settle();
		assert.equal(vault.held(), "OLD");
	});

	it("is simply absent when neither place has it, and a broken second copy changes nothing", async () => {
		assert.equal(await restorePhoneToken(), null);
		useKeyVault({ read: async () => { throw new Error("x"); }, write: async () => { throw new Error("x"); }, remove: async () => { throw new Error("x"); } });
		setPhoneToken("KEY");
		assert.equal(getPhoneToken(), "KEY");
		assert.equal(await restorePhoneToken(), "KEY");
		local.clear();
		assert.equal(await restorePhoneToken(), null);
	});
});

describe("the pairing page", () => {
	it("shows the form to a phone that has no key", async () => {
		const asked = macSays(200);
		await mount(<PairForm initialCode="ABCD-2345" />);
		assert.ok($("pair-form"));
		assert.equal((document.querySelector('[data-testid="pair-code"]') as HTMLInputElement).value, "ABCD-2345");
		assert.deepEqual(asked, [], "nothing is asked of the Mac");
		assert.deepEqual(replaced, []);
	});

	it("takes a paired phone straight to the app — the home-screen icon may open this address", async () => {
		setPhoneToken("KEY");
		macSays(200);
		await mount(<PairForm initialCode="ABCD-2345" />);
		assert.deepEqual(replaced, ["/m"]);
		assert.equal($("pair-form"), null, "no code is asked for");
	});

	it("does so too when the Mac cannot be reached — the key stands, pairing needs the Mac anyway", async () => {
		setPhoneToken("KEY");
		macSays("unreachable");
		await mount(<PairForm />);
		assert.deepEqual(replaced, ["/m"]);
	});

	it("finds the key in the second copy when localStorage is empty", async () => {
		setPhoneToken("KEY");
		await settle();
		local.clear();
		macSays(200);
		await mount(<PairForm />);
		assert.deepEqual(replaced, ["/m"]);
	});

	it("asks for a code when the Mac says the key was locked, and forgets that key", async () => {
		setPhoneToken("KEY");
		macSays(401);
		await mount(<PairForm />);
		assert.deepEqual(replaced, []);
		assert.ok($("pair-form"));
		assert.equal(getPhoneToken(), null);
		await settle();
		assert.equal(vault.held(), null);
	});
});

const course = (id: string, name: string, total: number): StudyCourseSummary => ({ id, name, daysLeft: null, total, counts: { new: 1, learning: 0, review: 2 }, newQuota: 20 });
const META = { v: 1 as const, deckAt: "2026-11-05T08:00:00.000Z", syncedAt: new Date(Date.now() - 5 * 60_000).toISOString(), macReviews: 0 };
function source(courses: StudyCourseSummary[]): PhoneSource {
	const api = { courses: async () => courses, weakSpots: async () => [] } as unknown as PhoneStudyApi;
	return {
		engine: { api, meta: META, unsent: () => 0, unsentReviews: () => [], unsentOps: () => [] },
		update: async () => { throw new Error("no update expected"); },
		restore: async () => { throw new Error("no restore expected"); },
	};
}
const open = (courses = [course("a", "Anatomy", 612), course("b", "Biology", 603)]) => async () => source(courses);

describe("the app start", () => {
	it("does not send a phone to the pairing page when only the second copy of the key is left", async () => {
		setPhoneToken("KEY");
		await settle();
		local.clear();
		macSays(200);
		await mount(<PhoneApp open={open()} />);
		assert.deepEqual(replaced, []);
		assert.ok($("phone-courses"));
		assert.equal(getPhoneToken(), "KEY");
	});

	it("sends it there when neither place has a key", async () => {
		macSays(200);
		await mount(<PhoneApp open={open()} />);
		assert.deepEqual(replaced, ["/m/pair"]);
		assert.equal($("phone-courses"), null);
	});

	it("shows what the phone holds on the course list", async () => {
		setPhoneToken("KEY");
		macSays(200);
		await mount(<PhoneApp open={open()} />);
		assert.match($("phone-storage")!.textContent ?? "", /On this phone: 1215 cards in 2 courses/);
	});
});

describe("the home-screen nudge", () => {
	it("is shown in Safari, once, and stays away after Got it", async () => {
		setPhoneToken("KEY");
		macSays(200);
		await mount(<PhoneApp open={open()} />);
		assert.ok($("phone-install-hint"));
		await act(async () => $("phone-install-hint-dismiss")!.click());
		assert.equal($("phone-install-hint"), null);
		await act(async () => root!.unmount());
		host!.remove();
		await mount(<PhoneApp open={open()} />);
		assert.equal($("phone-install-hint"), null, "dismissed for good");
	});

	it("is not shown in the installed app", async () => {
		Object.defineProperty(globalThis.navigator, "standalone", { value: true, configurable: true });
		setPhoneToken("KEY");
		macSays(200);
		await mount(<PhoneApp open={open()} />);
		assert.equal($("phone-install-hint"), null);
	});
});

describe("the storage line and the promise to keep it", () => {
	const courses = [course("a", "Anatomy", 1), course("b", "Biology", 2)];
	it("says what is held, how much space it takes, and whether iOS may clear it", () => {
		assert.equal(storageLine(null, null), "On this phone: 0 cards.");
		assert.equal(storageLine(courses, null), "On this phone: 3 cards in 2 courses.");
		assert.equal(storageLine(courses, { persistent: null }), "On this phone: 3 cards in 2 courses.");
		assert.equal(storageLine(courses, { persistent: true, usage: 38_000_000 }), "On this phone: 3 cards in 2 courses (38 MB). Storage is kept safe.");
		assert.equal(storageLine(courses, { persistent: false }), "On this phone: 3 cards in 2 courses. iOS may clear this storage.");
		assert.equal(storageLine([courses[0]!], { persistent: true }), "On this phone: 1 card in 1 course. Storage is kept safe.");
	});

	it("asks the browser to keep the storage unless it already promised, and reads the answer", async () => {
		const asked: string[] = [];
		const api = {
			persisted: async () => { asked.push("persisted"); return false; },
			persist: async () => { asked.push("persist"); return true; },
			estimate: async () => ({ usage: 5_000_000, quota: 900_000_000 }),
		};
		assert.deepEqual(await requestPersistentStorage(api), { persistent: true, usage: 5_000_000, quota: 900_000_000 });
		assert.deepEqual(asked, ["persisted", "persist"]);
		asked.length = 0;
		assert.deepEqual(await requestPersistentStorage({ ...api, persisted: async () => { asked.push("persisted"); return true; } }), { persistent: true, usage: 5_000_000, quota: 900_000_000 });
		assert.deepEqual(asked, ["persisted"], "no second request when it is promised already");
	});

	it("never throws: a browser without the API, or one that refuses, is not a promise", async () => {
		assert.deepEqual(await requestPersistentStorage(undefined), { persistent: null });
		assert.deepEqual(await requestPersistentStorage({ persist: async () => { throw new Error("no"); } }), { persistent: null });
		assert.deepEqual(await requestPersistentStorage({ persist: async () => false }), { persistent: false });
	});

	it("formats sizes for the line", () => {
		assert.equal(formatBytes(400), "1 KB");
		assert.equal(formatBytes(52_000), "52 KB");
		assert.equal(formatBytes(38_400_000), "38 MB");
		assert.equal(formatBytes(1_400_000_000), "1.4 GB");
	});
});
