/**
 * The phone gateway (Slice 10a), over real sockets: a fake Next server behind it, a real pairing service in front.
 * What matters: nothing outside the allowlist reaches the upstream, the capability header is ours and only ours,
 * a locked phone is out at once, and the listener is on 127.0.0.1 alone.
 */
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import type { MobileDevice } from "../src/core/contracts.ts";
import type { MobileStore } from "../src/core/ports.ts";
import { createMobileService } from "../src/server/mobile.ts";
import type { MobileService } from "../src/server/mobile.ts";
import { createGatewayServer } from "../src/server/mobile-gateway.ts";

const SECRET = "s".repeat(64);

interface Seen {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
	body: string;
}
let seen: Seen[] = [];
let upstream: http.Server;
let upstreamPort = 0;
let upstreamUp = true;
let gateway: http.Server;
let gatewayPort = 0;
let svc: MobileService;
let devices: MobileDevice[] = [];
let clock = Date.parse("2026-11-05T10:00:00.000Z");
let seed = 5;

const store: MobileStore = {
	readConfig: () => ({ v: 1, enabled: true, port: 47831 }),
	writeConfig: () => {},
	readDevices: () => devices.map((d) => ({ ...d })),
	writeDevices: (l) => void (devices = l.map((d) => ({ ...d }))),
};

before(async () => {
	upstream = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
			if (req.url?.startsWith("/m/pair")) return void res.writeHead(200, { "Content-Type": "text/html" }).end("<h1>pair</h1>");
			if (req.url?.includes("boom")) return void res.writeHead(500).end("oops");
			res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "a=b", Connection: "close" }).end(JSON.stringify({ ok: true, url: req.url }));
		});
	});
	await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
	upstreamPort = (upstream.address() as AddressInfo).port;
	svc = createMobileService({
		store,
		tailscale: { status: async () => ({ state: "unknown", httpsReady: false }), serving: async () => false, serve: async () => {}, stopServing: async () => {} },
		gateway: { listening: () => true, start: async () => {}, stop: async () => {} },
		now: () => clock,
		random: (n) => {
			const b = Buffer.alloc(n);
			for (let i = 0; i < n; i++) b[i] = seed = (seed * 131 + 17) % 251;
			return b;
		},
	});
	gateway = createGatewayServer({ service: svc, upstream: () => ({ port: upstreamUp ? upstreamPort : 1, secret: SECRET }), maxBodyBytes: 200 });
	await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
	gatewayPort = (gateway.address() as AddressInfo).port;
});

after(async () => {
	gateway.closeAllConnections();
	upstream.closeAllConnections();
	await Promise.all([new Promise((r) => gateway.close(r)), new Promise((r) => upstream.close(r))]);
});

beforeEach(() => {
	seen = [];
	devices = [];
	upstreamUp = true;
});

interface Reply {
	status: number;
	headers: http.IncomingHttpHeaders;
	text: string;
	json: () => Record<string, unknown>;
}
function call(method: string, path: string, opts: { headers?: http.OutgoingHttpHeaders; body?: string } = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: gatewayPort, method, path, headers: { ...(opts.body ? { "Content-Length": Buffer.byteLength(opts.body) } : {}), ...opts.headers } }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString();
				resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) as Record<string, unknown> });
			});
		});
		req.on("error", reject);
		req.end(opts.body);
	});
}

/** Pair a phone through the real endpoint; its key. */
async function pairPhone(name = "Phone"): Promise<string> {
	const offer = await svc.createPairing();
	const res = await call("POST", "/m-api/pair", { body: JSON.stringify({ code: offer.code, name }), headers: { "Content-Type": "application/json" } });
	assert.equal(res.status, 200, res.text);
	return res.json().token as string;
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("the app shell", () => {
	it("is open to anyone, and carries our capability header — never the phone's", async () => {
		const res = await call("GET", "/m/pair?code=ABCD2345", { headers: { "X-LearnHarness-Desktop": "forged", Cookie: "x=1", Authorization: "Bearer whatever-whatever-whatever" } });
		assert.equal(res.status, 200);
		assert.equal(res.text, "<h1>pair</h1>");
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.url, "/m/pair?code=ABCD2345", "the query string rides along");
		assert.equal(seen[0]!.headers["x-learnharness-desktop"], SECRET);
		assert.equal(seen[0]!.headers.cookie, undefined);
		assert.equal(seen[0]!.headers.authorization, undefined);
		assert.equal(seen[0]!.headers.host, `127.0.0.1:${upstreamPort}`);
	});
	it("serves the static assets the same way", async () => {
		assert.equal((await call("GET", "/_next/static/chunks/app.js")).status, 200);
		assert.equal((await call("GET", "/favicon.ico")).status, 200);
	});
});

describe("the phone API", () => {
	it("asks for a paired phone's key — no key, a made-up key, or a key in the wrong place is a 401 and never reaches Learnbox", async () => {
		assert.equal((await call("GET", "/api/phone/deck?reviewsFrom=0")).status, 401);
		assert.equal((await call("GET", "/api/phone/deck", { headers: auth("A".repeat(43)) })).status, 401);
		assert.equal((await call("GET", "/api/phone/deck", { headers: { Cookie: `Authorization=Bearer ${"A".repeat(43)}` } })).status, 401);
		assert.equal((await call("GET", "/api/phone/deck", { headers: { Authorization: "Basic abc" } })).status, 401);
		assert.deepEqual(seen, []);
	});

	it("lets a paired phone through, tells Learnbox which phone it was, and keeps the answer off the cache", async () => {
		const token = await pairPhone();
		const res = await call("GET", "/api/phone/deck?reviewsFrom=3", { headers: auth(token) });
		assert.equal(res.status, 200);
		assert.equal(res.headers["cache-control"], "no-store");
		assert.equal(res.json().url, "/api/phone/deck?reviewsFrom=3");
		assert.equal(seen[0]!.headers["x-learnharness-desktop"], SECRET);
		assert.equal(seen[0]!.headers["x-learnbox-device"], devices[0]!.id);
		assert.equal(seen[0]!.headers.authorization, undefined, "the phone's key stops at the gateway");
	});

	it("carries a POST body through", async () => {
		const token = await pairPhone();
		const body = JSON.stringify({ reviews: [{ cardId: "c1", at: "2026-11-05T09:00:00.000Z", grade: 3 }] });
		const res = await call("POST", "/api/phone/sync", { headers: { ...auth(token), "Content-Type": "application/json" }, body });
		assert.equal(res.status, 200);
		assert.equal(seen[0]!.method, "POST");
		assert.equal(seen[0]!.body, body);
	});

	it("is shut at once for a phone the learner locked", async () => {
		const token = await pairPhone();
		assert.equal((await call("GET", "/api/phone/deck", { headers: auth(token) })).status, 200);
		svc.revoke(devices[0]!.id);
		assert.equal((await call("GET", "/api/phone/deck", { headers: auth(token) })).status, 401);
		assert.equal((await call("GET", "/m-api/me", { headers: auth(token) })).status, 401);
	});

	it("refuses a body over the limit, announced or not, without sending it on", async () => {
		const token = await pairPhone();
		const big = "x".repeat(500);
		const announced = await call("POST", "/api/phone/sync", { headers: auth(token), body: big });
		assert.equal(announced.status, 413);
		assert.deepEqual(seen, []);
	});
});

describe("everything else is closed", () => {
	it("answers 404 and sends nothing upstream — even with a valid key", async () => {
		const token = await pairPhone();
		const closed: [string, string][] = [
			["GET", "/"], ["GET", "/study"], ["GET", "/api/settings/general"], ["PUT", "/api/settings/general"], ["GET", "/api/keys"], ["POST", "/api/keys"],
			["GET", "/api/subscriptions"], ["GET", "/api/study/anki"], ["POST", "/api/study/anki/import"], ["POST", "/api/study/courses"], ["POST", "/api/study/card"],
			["GET", "/api/study/courses"], ["GET", "/api/study/next"], ["GET", "/api/study/weak"], ["POST", "/api/study/answer"], ["POST", "/api/study/undo"],
			["GET", "/api/phone/sync"], ["POST", "/api/phone/deck"], ["POST", "/api/phone/backup"], ["POST", "/api/mobile/backup"], ["GET", "/api/mobile/backup"],
			["GET", "/api/chats"], ["GET", "/api/create/jobs"], ["GET", "/api/library"], ["GET", "/api/mobile"], ["POST", "/api/mobile"], ["POST", "/api/mobile/pair"],
			["GET", "/api/events"], ["GET", "/m/../api/keys"], ["GET", "/m/%2e%2e/api/keys"], ["GET", "/_next/static/../../api/keys"], ["GET", "//api/keys"],
			["GET", "/api/phone%2fdeck"], ["OPTIONS", "/api/phone/deck"], ["PUT", "/api/phone/sync"], ["GET", "/m-api/pair"], ["GET", "/m-api/other"],
		];
		for (const [method, path] of closed) {
			const res = await call(method, path, { headers: auth(token) });
			assert.equal(res.status, 404, `${method} ${path}`);
		}
		assert.deepEqual(seen, [], "not one request reached Learnbox");
	});
});

describe("pairing through the gateway", () => {
	it("trades a code for a key once; the key then opens /m-api/me", async () => {
		const offer = await svc.createPairing();
		const body = JSON.stringify({ code: offer.code, name: "Daniel's iPhone" });
		const res = await call("POST", "/m-api/pair", { body });
		assert.equal(res.status, 200);
		assert.equal(res.headers["cache-control"], "no-store");
		const token = res.json().token as string;
		assert.equal((res.json().device as { name: string }).name, "Daniel's iPhone");
		const me = await call("GET", "/m-api/me", { headers: auth(token) });
		assert.equal(me.status, 200);
		assert.deepEqual(me.json(), { device: { id: devices[0]!.id, name: "Daniel's iPhone" } });
		assert.equal((await call("POST", "/m-api/pair", { body })).status, 403, "a code is good for one phone");
		assert.deepEqual(seen, [], "pairing never touches Learnbox");
	});

	it("refuses a request that is not JSON or not a code, and a stranger's key", async () => {
		assert.equal((await call("POST", "/m-api/pair", { body: "nope" })).status, 400);
		assert.equal((await call("POST", "/m-api/pair", { body: "[]" })).status, 400);
		assert.equal((await call("POST", "/m-api/pair", { body: JSON.stringify({ code: "hello" }) })).status, 400);
		assert.equal((await call("POST", "/m-api/pair", { body: JSON.stringify({ code: "ZZZZ-ZZZZ" }) })).status, 403);
		assert.equal((await call("GET", "/m-api/me")).status, 401);
		assert.equal((await call("POST", "/m-api/pair", { body: JSON.stringify({ code: "x".repeat(5000) }) })).status, 400, "an oversized body is not read");
	});
});

describe("when Learnbox is not there", () => {
	it("says 502 instead of hanging, and passes an upstream error on as it is", async () => {
		const token = await pairPhone();
		upstreamUp = false;
		assert.equal((await call("GET", "/api/phone/deck", { headers: auth(token) })).status, 502);
		upstreamUp = true;
		assert.equal((await call("GET", "/m/boom")).status, 500);
	});
});

describe("the listener", () => {
	it("is bound to 127.0.0.1 and nowhere else", () => {
		assert.equal((gateway.address() as AddressInfo).address, "127.0.0.1");
	});
});
