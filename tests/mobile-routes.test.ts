/**
 * Phone access through Settings' routes and the real listener (Slice 10a): the real store in a temp data dir, a fake
 * Tailscale, a fake Next server behind the gateway. LH_DATA_DIR is set BEFORE the first import (config.ts reads it at load).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { MobileStatus, PairingOffer, TailscaleState } from "../src/core/contracts.ts";
import type { TailscaleRunner } from "../src/server/tailscale.ts";

const READY: TailscaleState = { state: "running", host: "mac.t.ts.net", httpsReady: true };
const SECRET = "k".repeat(64);

let dir = "";
let port = 0;
let ts: { state: TailscaleState; serving: boolean; calls: string[] };
let upstream: http.Server;
let upstreamSeen: http.IncomingHttpHeaders[] = [];
let mod: typeof import("../src/server/mobile.ts");
let gw: typeof import("../src/server/mobile-gateway.ts");
let store: typeof import("../src/store/mobile.ts");

const freePort = () =>
	new Promise<number>((resolve) => {
		const s = net.createServer().listen(0, "127.0.0.1", () => {
			const p = (s.address() as net.AddressInfo).port;
			s.close(() => resolve(p));
		});
	});

const fakeTailscale: TailscaleRunner = {
	status: async () => ts.state,
	serving: async () => ts.serving,
	serve: async (p) => {
		ts.calls.push(`serve ${p}`);
		ts.serving = true;
	},
	stopServing: async () => {
		ts.calls.push("off");
		ts.serving = false;
	},
};

before(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-routes-"));
	process.env.LH_DATA_DIR = dir;
	upstream = http.createServer((req, res) => {
		upstreamSeen.push(req.headers);
		res.writeHead(200, { "Content-Type": "text/plain" }).end("shell");
	});
	await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
	process.env.PORT = String((upstream.address() as net.AddressInfo).port);
	process.env.LH_DESKTOP_API_SECRET = SECRET;
	mod = await import("../src/server/mobile.ts");
	gw = await import("../src/server/mobile-gateway.ts");
	store = await import("../src/store/mobile.ts");
});

after(async () => {
	await gw.stopMobileGateway();
	delete (globalThis as { __lhMobileService?: unknown }).__lhMobileService;
	delete process.env.LH_DATA_DIR;
	delete process.env.PORT;
	delete process.env.LH_DESKTOP_API_SECRET;
	upstream.closeAllConnections();
	await new Promise((r) => upstream.close(r));
	fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	await gw.stopMobileGateway();
	fs.rmSync(path.join(dir, "mobile"), { recursive: true, force: true });
	port = await freePort();
	store.mobileStore.writeConfig({ v: 1, enabled: false, port });
	ts = { state: READY, serving: false, calls: [] };
	upstreamSeen = [];
	// The process's one service, with Tailscale faked and the REAL listener.
	(globalThis as { __lhMobileService?: unknown }).__lhMobileService = mod.createMobileService({
		store: store.mobileStore,
		tailscale: fakeTailscale,
		gateway: { listening: () => (globalThis as { __lhMobileGateway?: { listening: boolean } }).__lhMobileGateway?.listening === true, start: gw.startMobileGateway, stop: gw.stopMobileGateway },
		now: Date.now,
		random: (await import("node:crypto")).randomBytes,
	});
});

const json = (method: string, body?: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function api<T = Record<string, unknown>>(handler: Promise<Response>): Promise<{ status: number; body: T }> {
	const res = await handler;
	return { status: res.status, body: (await res.json().catch(() => null)) as T };
}
const status = async () => (await api<MobileStatus>((await import("../app/api/mobile/route.ts")).GET())).body;
const post = async (route: string, body?: unknown) => (await import(`../app/api/mobile/${route}`)).POST(new Request("http://localhost/x", json("POST", body)));

/** A request to the real listener on 127.0.0.1:<port>. */
function viaGateway(method: string, p: string, opts: { body?: string; headers?: http.OutgoingHttpHeaders } = {}): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: opts.headers, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
		});
		req.on("error", reject);
		req.end(opts.body);
	});
}

describe("Settings → Phone", () => {
	it("starts off: nothing listens, no phones, and Tailscale is read from the fake", async () => {
		const s = await status();
		assert.deepEqual({ enabled: s.enabled, listening: s.listening, port: s.port, devices: s.devices, url: s.url }, { enabled: false, listening: false, port, devices: [], url: "https://mac.t.ts.net" });
		await assert.rejects(viaGateway("GET", "/m-api/me"), /ECONNREFUSED/);
	});

	it("switches the real gateway on and off, and remembers the switch", async () => {
		const on = await api<MobileStatus>(post("route.ts", { enabled: true }));
		assert.equal(on.status, 200);
		assert.equal(on.body.listening, true);
		assert.equal(store.mobileStore.readConfig().enabled, true);
		assert.equal((await viaGateway("GET", "/m-api/me")).status, 401, "our gateway answers");
		const off = await api<MobileStatus>(post("route.ts", { enabled: false }));
		assert.equal(off.body.listening, false);
		assert.equal(store.mobileStore.readConfig().enabled, false);
		await assert.rejects(viaGateway("GET", "/m-api/me"), /ECONNREFUSED/);
	});

	it("resumes after a restart: switched on stays on", async () => {
		await post("route.ts", { enabled: true });
		await gw.stopMobileGateway(); // the app quit
		assert.equal((await status()).listening, false);
		await mod.mobile().resume();
		assert.equal((await status()).listening, true);
	});

	it("says 409 when the gateway's port is taken, and stays off", async () => {
		const squatter = net.createServer().listen(port, "127.0.0.1");
		await new Promise((r) => squatter.once("listening", r));
		const res = await api<{ error: string }>(post("route.ts", { enabled: true }));
		assert.equal(res.status, 409);
		assert.match(res.body.error, /port/i);
		assert.equal(store.mobileStore.readConfig().enabled, false);
		await new Promise((r) => squatter.close(r));
	});

	it("refuses a request without a proper switch value", async () => {
		assert.equal((await api(post("route.ts", {}))).status, 400);
		assert.equal((await api(post("route.ts", { enabled: "yes" }))).status, 400);
		assert.equal((await api(post("serve/route.ts", {}))).status, 400);
	});

	it("shares with Tailscale on the click and says what is missing otherwise", async () => {
		assert.equal((await api(post("serve/route.ts", { on: true }))).status, 409, "gateway not on yet");
		await post("route.ts", { enabled: true });
		ts.state = { state: "needs-login", httpsReady: false };
		const refused = await api<{ error: string }>(post("serve/route.ts", { on: true }));
		assert.deepEqual([refused.status, /Sign in/.test(refused.body.error)], [409, true]);
		assert.deepEqual(ts.calls, []);
		ts.state = READY;
		const ok = await api<MobileStatus>(post("serve/route.ts", { on: true }));
		assert.deepEqual([ok.status, ok.body.serving, ts.calls], [200, true, [`serve ${port}`]]);
		const off = await api<MobileStatus>(post("route.ts", { enabled: false }));
		assert.equal(off.body.serving, false, "switching off takes our Serve down");
		assert.deepEqual(ts.calls, [`serve ${port}`, "off"]);
	});
});

describe("pairing a phone, end to end", () => {
	it("a code from the Mac becomes a key on the phone; the phone reaches the shell with Learnbox's capability; locking shuts it out; forgetting removes it", async () => {
		assert.equal((await api(post("pair/route.ts"))).status, 409, "no code while the gateway is off");
		await post("route.ts", { enabled: true });

		const offer = (await api<PairingOffer>(post("pair/route.ts"))).body;
		assert.equal(offer.pairUrl, `https://mac.t.ts.net/m/pair?code=${offer.code}`);
		assert.ok(offer.qr && offer.qr.length > 20);

		const paired = await viaGateway("POST", "/m-api/pair", { body: JSON.stringify({ code: offer.code, name: "Daniel's iPhone" }) });
		assert.equal(paired.status, 200);
		const token = (JSON.parse(paired.text) as { token: string }).token;
		const list = (await status()).devices;
		assert.deepEqual(list.map((d) => [d.name, d.revoked]), [["Daniel's iPhone", false]]);
		assert.ok(!fs.readFileSync(path.join(dir, "mobile", "devices.json"), "utf-8").includes(token), "the key itself is not on disk");

		// through the real listener to the fake Next server
		const shell = await viaGateway("GET", "/m/pair", { headers: { "X-LearnHarness-Desktop": "forged" } });
		assert.deepEqual([shell.status, shell.text, upstreamSeen[0]!["x-learnharness-desktop"]], [200, "shell", SECRET]);
		assert.equal((await viaGateway("GET", "/api/study/next", { headers: { Authorization: `Bearer ${token}` } })).status, 200);
		assert.equal((await viaGateway("GET", "/api/keys", { headers: { Authorization: `Bearer ${token}` } })).status, 404);

		const devices = await import("../app/api/mobile/devices/[id]/route.ts");
		const id = list[0]!.id;
		assert.equal((await devices.POST(new Request("http://localhost/x"), ctx(id))).status, 200);
		assert.equal((await viaGateway("GET", "/api/study/next", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
		assert.equal((await status()).devices[0]!.revoked, true);
		assert.equal((await devices.DELETE(new Request("http://localhost/x"), ctx(id))).status, 204);
		assert.deepEqual((await status()).devices, []);
		assert.equal((await devices.POST(new Request("http://localhost/x"), ctx(id))).status, 404);
		assert.equal((await devices.DELETE(new Request("http://localhost/x"), ctx(id))).status, 404);
	});
});
