/** Phone access, the pure rules (Slice 10a): what the gateway lets through, pairing codes, Tailscale status, stored records. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_MOBILE_CONFIG,
	cleanDevice,
	cleanDeviceName,
	cleanMobileConfig,
	deviceSummaries,
	formatPairingCode,
	mobileRoute,
	normalizePairingCode,
	parseTailscaleStatus,
	serveForwardsTo,
	tailscaleUrl,
} from "../src/core/mobile.ts";
import { DEVICE_NAME_MAX, MOBILE_DEFAULT_PORT } from "../src/core/contracts.ts";

const HASH = "a".repeat(64);

describe("the stored config", () => {
	it("falls back to 'off, default port' for anything that is not a config", () => {
		for (const junk of [undefined, null, 7, "x", [], {}]) assert.deepEqual(cleanMobileConfig(junk), DEFAULT_MOBILE_CONFIG);
		assert.equal(DEFAULT_MOBILE_CONFIG.enabled, false);
	});
	it("keeps a good port and switch, and only a real true switches access on", () => {
		assert.deepEqual(cleanMobileConfig({ enabled: true, port: 50000 }), { v: 1, enabled: true, port: 50000 });
		assert.equal(cleanMobileConfig({ enabled: "yes" }).enabled, false);
		for (const port of [80, 1023, 65536, 1.5, "47831", NaN]) assert.equal(cleanMobileConfig({ port }).port, MOBILE_DEFAULT_PORT);
	});
});

describe("device names and records", () => {
	it("cleans a typed name: one line, trimmed, capped, never blank", () => {
		assert.equal(cleanDeviceName("  Daniel's   iPhone \n"), "Daniel's iPhone");
		assert.equal(cleanDeviceName("a\u0000b\tc"), "a b c");
		assert.equal(cleanDeviceName(""), "iPhone");
		assert.equal(cleanDeviceName(42), "iPhone");
		assert.equal(cleanDeviceName("x".repeat(100)).length, DEVICE_NAME_MAX);
	});
	it("reads a stored device back, and drops what is not one", () => {
		const ok = { id: "dev_1", name: "Phone", tokenHash: HASH, createdAt: "2026-11-05T10:00:00.000Z", lastSeenAt: "2026-11-05T11:00:00.000Z", revokedAt: "2026-11-05T12:00:00.000Z" };
		assert.deepEqual(cleanDevice(ok), ok);
		assert.deepEqual(cleanDevice({ ...ok, lastSeenAt: undefined, revokedAt: 3 }), { id: "dev_1", name: "Phone", tokenHash: HASH, createdAt: ok.createdAt });
		for (const bad of [null, "x", { ...ok, id: "" }, { ...ok, tokenHash: "short" }, { ...ok, tokenHash: "G".repeat(64) }, { ...ok, createdAt: "nope" }]) assert.equal(cleanDevice(bad), null);
	});
	it("lists devices newest first and never shows the key hash", () => {
		const list = deviceSummaries([
			{ id: "old", name: "A", tokenHash: HASH, createdAt: "2026-11-01T00:00:00.000Z", revokedAt: "2026-11-02T00:00:00.000Z" },
			{ id: "new", name: "B", tokenHash: HASH, createdAt: "2026-11-05T00:00:00.000Z", lastSeenAt: "2026-11-05T01:00:00.000Z" },
		]);
		assert.deepEqual(list.map((d) => [d.id, d.revoked]), [["new", false], ["old", true]]);
		assert.ok(list.every((d) => !("tokenHash" in d)));
		assert.equal(list[0]!.lastSeenAt, "2026-11-05T01:00:00.000Z");
	});
});

describe("pairing codes", () => {
	it("reads what was typed: case, dashes and spaces do not matter", () => {
		assert.equal(normalizePairingCode("abcd-2345"), "ABCD2345");
		assert.equal(normalizePairingCode(" ab cd 2345 "), "ABCD2345");
		assert.equal(formatPairingCode("ABCD2345"), "ABCD-2345");
	});
	it("refuses what cannot be a code: wrong length, the letters and digits the alphabet leaves out", () => {
		for (const bad of ["", "ABCD234", "ABCD23456", "ABCD-234O", "ABCD-2341", "ABCD-2340", "ABCD-234I", 5, null, undefined]) assert.equal(normalizePairingCode(bad), null, String(bad));
	});
});

describe("Tailscale status", () => {
	it("reads a running node with HTTPS ready", () => {
		assert.deepEqual(parseTailscaleStatus({ BackendState: "Running", Self: { DNSName: "mac.tail1234.ts.net." }, CertDomains: ["mac.tail1234.ts.net"] }), {
			state: "running",
			host: "mac.tail1234.ts.net",
			httpsReady: true,
		});
	});
	it("says HTTPS is not ready when the tailnet issues no certificate for this host", () => {
		assert.equal(parseTailscaleStatus({ BackendState: "Running", Self: { DNSName: "mac.t.ts.net." }, CertDomains: null }).httpsReady, false);
		assert.equal(parseTailscaleStatus({ BackendState: "Running", Self: { DNSName: "mac.t.ts.net." }, CertDomains: ["other.t.ts.net"] }).httpsReady, false);
	});
	it("maps the other backend states and shrugs at garbage", () => {
		assert.equal(parseTailscaleStatus({ BackendState: "NeedsLogin", Self: { DNSName: "" } }).state, "needs-login");
		assert.equal(parseTailscaleStatus({ BackendState: "NeedsMachineAuth" }).state, "needs-login");
		assert.equal(parseTailscaleStatus({ BackendState: "Stopped" }).state, "stopped");
		assert.deepEqual(parseTailscaleStatus({ BackendState: "Starting" }), { state: "unknown", httpsReady: false });
		for (const junk of [null, undefined, "x", 3, []]) assert.deepEqual(parseTailscaleStatus(junk), { state: "unknown", httpsReady: false });
	});
	it("builds the address the phone opens", () => assert.equal(tailscaleUrl("mac.t.ts.net"), "https://mac.t.ts.net"));
	it("recognises a Serve config that forwards to our port, however it is spelled", () => {
		const serve = (proxy: string) => ({ TCP: { "443": { HTTPS: true } }, Web: { "mac.t.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } } });
		assert.equal(serveForwardsTo(serve("http://127.0.0.1:47831"), 47831), true);
		assert.equal(serveForwardsTo(serve("http://localhost:47831/"), 47831), true);
		assert.equal(serveForwardsTo(serve("http://127.0.0.1:3000"), 47831), false);
		assert.equal(serveForwardsTo(serve("http://127.0.0.1:478310"), 47831), false);
		for (const junk of [null, {}, { Web: null }, { Web: { x: { Handlers: null } } }, "x"]) assert.equal(serveForwardsTo(junk, 47831), false);
	});
});

describe("what the gateway lets through", () => {
	it("opens the app shell and its assets to anyone who reaches the gateway", () => {
		for (const [m, p] of [["GET", "/m"], ["GET", "/m/"], ["GET", "/m/pair"], ["HEAD", "/m/sw.js"], ["GET", "/m/icon-192.png"], ["GET", "/_next/static/chunks/a.js"], ["GET", "/favicon.ico"], ["GET", "/fonts/cmunbx.ttf"], ["HEAD", "/fonts/cmunbx.ttf"]] as const) {
			assert.equal(mobileRoute(m, p), "public", `${m} ${p}`);
		}
	});
	it("asks the listed API routes for a paired phone", () => {
		for (const [m, p] of [["GET", "/api/study/courses"], ["GET", "/api/study/next"], ["GET", "/api/study/weak"], ["POST", "/api/study/answer"], ["POST", "/api/study/undo"], ["GET", "/api/study/next/"]] as const) {
			assert.equal(mobileRoute(m, p), "device", `${m} ${p}`);
		}
	});
	it("closes everything else — settings, keys, billing, imports, chats, creation, the root", () => {
		for (const [m, p] of [
			["GET", "/"], ["GET", "/study"], ["GET", "/settings"], ["GET", "/chat/new"], ["GET", "/create"],
			["GET", "/api/settings/general"], ["PUT", "/api/settings/general"], ["GET", "/api/keys"], ["POST", "/api/keys"], ["GET", "/api/subscriptions"],
			["GET", "/api/study/anki"], ["POST", "/api/study/anki/import"], ["POST", "/api/study/courses"], ["POST", "/api/study/card"],
			["GET", "/api/chats"], ["GET", "/api/create/jobs"], ["GET", "/api/library"], ["GET", "/api/mobile"], ["POST", "/api/mobile/pair"], ["GET", "/api/events"],
			["GET", "/m-api/pair"], ["GET", "/mobile"], ["GET", "/mm"], ["GET", "/M"], ["GET", "/_next/static"], ["GET", "/_next/data/x.json"], ["GET", "/_next/image"], ["GET", "/fonts"], ["GET", "/fonts/"], ["GET", "/fonts/a/b.ttf"], ["POST", "/fonts/cmunbx.ttf"], ["GET", "/siwc/x.js"],
		] as const) {
			assert.equal(mobileRoute(m, p), "deny", `${m} ${p}`);
		}
	});
	it("allows only the listed methods", () => {
		assert.equal(mobileRoute("POST", "/m/pair"), "deny");
		assert.equal(mobileRoute("DELETE", "/m"), "deny");
		assert.equal(mobileRoute("GET", "/api/study/answer"), "deny");
		assert.equal(mobileRoute("POST", "/api/study/next"), "deny");
		assert.equal(mobileRoute("PATCH", "/api/study/answer"), "deny");
		assert.equal(mobileRoute("OPTIONS", "/api/study/next"), "deny");
	});
	it("refuses a path that could be read two ways, instead of cleaning it up", () => {
		for (const p of [
			"/m/../api/keys", "/m/./pair", "/m/..", "/_next/static/../../api/keys", "//api/study/next", "/m//pair", "/api//study/next",
			"/m/%2e%2e/api/keys", "/m/%2E%2E/api/keys", "/m/..%2fapi", "/m%2fpair", "/api/study%2fnext", "/m/a%5cb", "/m\\pair", "/m/a%00b", "/m/a\u0000b", "/m/a\nb",
			"api/study/next", "", "*",
		]) {
			assert.equal(mobileRoute("GET", p), "deny", JSON.stringify(p));
		}
	});
});
