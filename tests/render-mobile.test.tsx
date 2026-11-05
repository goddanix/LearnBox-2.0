/**
 * Phone access (Learnbox 2.0, Slice 10a), in a live linkedom page with the server's answers faked:
 * the Settings → Phone section (switch on, Tailscale line, share, pairing code + QR, paired phones, lock/remove),
 * the pairing form on the phone, and the shell switch that keeps the desktop chrome off the phone's pages.
 */
import { dom } from "./helpers/linkedom-page.ts";
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { PhoneSection } from "../components/settings/phone-section.tsx";
import { isPhonePath } from "../components/mobile/shell-switch.tsx";
import { getPhoneToken, clearPhoneToken, setPhoneToken, phoneFetch } from "../components/mobile/phone-auth.ts";
import type { MobileDeviceSummary, MobileStatus, PairingOffer } from "../src/core/index.ts";

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

const DEVICE: MobileDeviceSummary = { id: "d1", name: "Danny's iPhone", createdAt: "2026-11-05T09:00:00.000Z", lastSeenAt: "2026-11-05T09:30:00.000Z", revoked: false };
const STATUS: MobileStatus = {
	enabled: true,
	port: 47831,
	listening: true,
	tailscale: { state: "running", host: "mac.tail1234.ts.net", httpsReady: true },
	serving: false,
	url: "https://mac.tail1234.ts.net",
	devices: [],
};
const OFFER: PairingOffer = {
	code: "ABCD2345",
	expiresAt: "2026-11-05T10:10:00.000Z",
	pairUrl: "https://mac.tail1234.ts.net/m/pair?code=ABCD2345",
	qr: ["1010", "0101", "1010", "0101"],
};

interface Sent {
	url: string;
	method: string;
	body: Record<string, unknown> | null;
}
/** A server whose status can change between requests; records every request. */
function fakeServer(initial: MobileStatus, extra: Record<string, (sent: Sent) => unknown> = {}): { sent: Sent[]; status: MobileStatus } {
	const state = { sent: [] as Sent[], status: initial };
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		const entry: Sent = { url, method: init?.method ?? "GET", body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null };
		state.sent.push(entry);
		for (const [key, answer] of Object.entries(extra)) {
			if (`${entry.method} ${url}` !== key) continue;
			const out = answer(entry);
			// a status answer is the new truth, as on the real server
			if (typeof out === "object" && out !== null && "devices" in out) state.status = out as MobileStatus;
			return Response.json(out);
		}
		if (url === "/api/mobile" && entry.method === "GET") return Response.json(state.status);
		if (url === "/api/mobile" && entry.method === "POST") {
			state.status = { ...state.status, enabled: entry.body?.enabled === true };
			return Response.json(state.status);
		}
		return new Response(JSON.stringify({ error: `unexpected ${entry.method} ${url}` }), { status: 404 });
	}) as typeof fetch;
	return state as { sent: Sent[]; status: MobileStatus };
}

describe("Settings → Phone", () => {
	it("starts switched off with nothing to pair, and says what Tailscale needs", async () => {
		fakeServer({ ...STATUS, enabled: false, listening: false, tailscale: { state: "needs-login", httpsReady: false } });
		await mount(<PhoneSection />);
		assert.equal($("toggle-phone-access")!.getAttribute("aria-checked"), "false");
		assert.match($("phone-tailscale-state")!.textContent ?? "", /not signed in/);
		assert.equal($("phone-serve"), null, "no share button before Tailscale is ready");
		assert.equal($("phone-show-code")!.hasAttribute("disabled"), true, "no code while the gateway is not listening");
		assert.match($("phone-devices")!.textContent ?? "", /No phone is paired yet/);
	});

	it("switching on posts the choice and shows the new state", async () => {
		const server = fakeServer({ ...STATUS, enabled: false, listening: false });
		await mount(<PhoneSection />);
		await click($("toggle-phone-access"));
		assert.deepEqual(server.sent.find((s) => s.method === "POST")?.body, { enabled: true });
		assert.equal($("toggle-phone-access")!.getAttribute("aria-checked"), "true");
	});

	it("shows the exact share command, and the share button asks the server", async () => {
		const server = fakeServer(STATUS, {
			"POST /api/mobile/serve": () => ({ ...STATUS, serving: true }),
		});
		await mount(<PhoneSection />);
		assert.match($("phone-tailscale")!.textContent ?? "", /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:47831/);
		await click($("phone-serve"));
		assert.deepEqual(server.sent.find((s) => s.url === "/api/mobile/serve")?.body, { on: true });
		assert.equal($("phone-serve")!.textContent, "Stop sharing");
	});

	it("asks for the HTTPS switch when Tailscale has no certificate yet", async () => {
		fakeServer({ ...STATUS, tailscale: { state: "running", host: "mac.tail1234.ts.net", httpsReady: false } });
		await mount(<PhoneSection />);
		assert.match($("phone-tailscale-state")!.textContent ?? "", /HTTPS Certificates/);
		assert.equal($("phone-serve"), null);
	});

	it("shows a pairing code with its QR code, and hides it again", async () => {
		fakeServer(STATUS, { "POST /api/mobile/pair": () => OFFER });
		await mount(<PhoneSection />);
		await click($("phone-show-code"));
		assert.equal($("phone-code")!.textContent, "ABCD-2345");
		const qr = $("phone-qr")!;
		assert.equal(qr.getAttribute("viewBox"), "0 0 12 12", "4 modules + a 4-module quiet zone on each side");
		assert.equal(qr.querySelector("path")!.getAttribute("d"), "M4 4h1v1h-1zM6 4h1v1h-1zM5 5h1v1h-1zM7 5h1v1h-1zM4 6h1v1h-1zM6 6h1v1h-1zM5 7h1v1h-1zM7 7h1v1h-1z");
		await click($("phone-hide-code"));
		assert.equal($("phone-offer"), null);
		assert.ok($("phone-show-code"));
	});

	it("says a phone address is still missing when the offer has no link", async () => {
		const { pairUrl: _p, qr: _q, ...bare } = OFFER;
		fakeServer(STATUS, { "POST /api/mobile/pair": () => bare });
		await mount(<PhoneSection />);
		await click($("phone-show-code"));
		assert.equal($("phone-qr"), null);
		assert.match($("phone-offer")!.textContent ?? "", /No phone address yet/);
	});

	it("lists paired phones; Lock posts the lock, Remove deletes", async () => {
		const server = fakeServer({ ...STATUS, devices: [DEVICE, { ...DEVICE, id: "d2", name: "Old phone", revoked: true }] });
		await mount(<PhoneSection />);
		assert.equal($$("phone-device").length, 2);
		assert.equal($$("phone-lock").length, 1, "a locked phone has no Lock button");
		assert.match($$("phone-device")[1]!.textContent ?? "", /Locked/);
		await click($("phone-lock"));
		assert.ok(server.sent.some((s) => s.method === "POST" && s.url === "/api/mobile/devices/d1"));
		await click($$("phone-forget")[0] ?? null);
		assert.ok(server.sent.some((s) => s.method === "DELETE" && s.url === "/api/mobile/devices/d1"));
	});

	it("shows the server's message when a step fails", async () => {
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			if (url === "/api/mobile/serve") return new Response(JSON.stringify({ error: "Switch on HTTPS first." }), { status: 409 });
			return Response.json(STATUS);
		}) as typeof fetch;
		await mount(<PhoneSection />);
		await click($("phone-serve"));
		assert.match($("phone-error")!.textContent ?? "", /Switch on HTTPS first/);
	});

	describe("a backup file from a phone (Slice 10d)", () => {
		const pick = async (file: { size: number; text: () => Promise<string> }) => {
			const input = $("phone-backup-input")!;
			Object.defineProperty(input, "files", { value: [file], configurable: true });
			await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
			await settle();
		};
		const asFile = (text: string, size = text.length) => ({ size, text: async () => text });
		const FILE = { v: 1, kind: "learnbox-phone-backup", createdAt: "2026-11-05T20:00:00.000Z", reviews: [{ cardId: "c1", at: "2026-11-05T19:00:00.000Z", grade: 3 }] };

		it("is posted as it is, and the summary of what the Mac took in is shown", async () => {
			const server = fakeServer(STATUS, { "POST /api/mobile/backup": () => ({ added: 3, known: 1, unknownCards: 0, rejected: 2, reviewsTotal: 40, cardChanges: { applied: 2, known: 0, newerOnMac: 1, unknownCards: 0, rejected: 0 } }) });
			await mount(<PhoneSection />);
			assert.equal($("phone-backup-note"), null);
			await pick(asFile(JSON.stringify(FILE)));
			assert.deepEqual(server.sent.find((s) => s.url === "/api/mobile/backup")?.body, FILE);
			assert.equal($("phone-backup-note")!.textContent, "3 new answers taken in, 1 already there, 2 unreadable lines skipped, 2 card changes taken in, 1 card change left out because the card was changed on the Mac since.");
			assert.equal($("phone-error"), null);
		});

		it("is refused on the spot when it is not JSON or far too big — nothing is sent", async () => {
			const server = fakeServer(STATUS);
			await mount(<PhoneSection />);
			await pick(asFile("not json {"));
			assert.match($("phone-error")!.textContent ?? "", /not a Learnbox phone backup file/);
			await pick(asFile(JSON.stringify(FILE), 21 * 1024 * 1024));
			assert.match($("phone-error")!.textContent ?? "", /not a Learnbox phone backup file/);
			assert.ok(!server.sent.some((s) => s.url === "/api/mobile/backup"));
		});

		it("shows the Mac's message when it is JSON but not a backup, and clears an old summary", async () => {
			let answer: () => Response = () => Response.json({ added: 1, known: 0, unknownCards: 0, rejected: 0, reviewsTotal: 1, cardChanges: { applied: 0, known: 0, newerOnMac: 0, unknownCards: 0, rejected: 0 } });
			const inner = fakeServer(STATUS);
			const base = globalThis.fetch;
			globalThis.fetch = (async (input: unknown, init?: RequestInit) => (String(input) === "/api/mobile/backup" ? answer() : base(input as RequestInfo, init))) as typeof fetch;
			void inner;
			await mount(<PhoneSection />);
			await pick(asFile(JSON.stringify(FILE)));
			assert.match($("phone-backup-note")!.textContent ?? "", /1 new answer taken in/);
			answer = () => new Response(JSON.stringify({ error: "This is not a Learnbox phone backup file." }), { status: 400 });
			await pick(asFile("{}"));
			assert.equal($("phone-backup-note"), null, "the old summary is gone");
			assert.match($("phone-error")!.textContent ?? "", /not a Learnbox phone backup file/);
		});
	});
});

describe("the shell switch", () => {
	it("treats /m and everything under it as the phone's pages, nothing else", () => {
		for (const p of ["/m", "/m/", "/m/pair", "/m/study/abc"]) assert.equal(isPhonePath(p), true, p);
		for (const p of ["/", "/study", "/create", "/mobile", "/map", "/api/mobile", "", null]) assert.equal(isPhonePath(p), false, String(p));
	});
});

describe("the phone's key", () => {
	const store = new Map<string, string>();
	const install = () => {
		Object.assign(globalThis, {
			localStorage: {
				getItem: (k: string) => store.get(k) ?? null,
				setItem: (k: string, v: string) => void store.set(k, v),
				removeItem: (k: string) => void store.delete(k),
			},
		});
	};

	it("is stored, read back, and cleared", () => {
		install();
		store.clear();
		assert.equal(getPhoneToken(), null);
		setPhoneToken("abc");
		assert.equal(getPhoneToken(), "abc");
		clearPhoneToken();
		assert.equal(getPhoneToken(), null);
	});

	it("survives storage that refuses to work", () => {
		Object.assign(globalThis, {
			localStorage: {
				getItem: () => { throw new Error("blocked"); },
				setItem: () => { throw new Error("blocked"); },
				removeItem: () => { throw new Error("blocked"); },
			},
		});
		assert.equal(getPhoneToken(), null);
		assert.doesNotThrow(() => setPhoneToken("abc"));
		assert.doesNotThrow(() => clearPhoneToken());
	});

	it("goes out as a bearer header, and a 401 drops the key", async () => {
		install();
		store.clear();
		setPhoneToken("KEY123");
		let seen: string | null = null;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			seen = new Headers(init?.headers).get("Authorization");
			return new Response("{}", { status: 401 });
		}) as typeof fetch;
		const res = await phoneFetch("/api/phone/deck");
		assert.equal(seen, "Bearer KEY123");
		assert.equal(res.status, 401);
		assert.equal(getPhoneToken(), null);
	});
});
