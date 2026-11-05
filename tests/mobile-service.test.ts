/** Phone access, the service (Slice 10a): pairing, keys, revoking, and the two switches — with fakes for the clock, the files, Tailscale and the listener. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { PAIRING_CODE_ALPHABET, PAIRING_MAX_FAILURES, PAIRING_TTL_MS } from "../src/core/contracts.ts";
import type { MobileConfig, MobileDevice, TailscaleState } from "../src/core/contracts.ts";
import type { MobileStore } from "../src/core/ports.ts";
import { MobileError, createMobileService } from "../src/server/mobile.ts";
import type { GatewayControl, MobileService } from "../src/server/mobile.ts";
import { TailscaleError } from "../src/server/tailscale.ts";
import type { TailscaleRunner } from "../src/server/tailscale.ts";

const READY: TailscaleState = { state: "running", host: "mac.t.ts.net", httpsReady: true };

let clock = 0;
let seed = 0;
let config: MobileConfig;
let devices: MobileDevice[];
let writes: number;
let ts: { state: TailscaleState; serving: boolean; calls: string[]; failServe?: boolean; failStatus?: boolean };
let up: boolean;
let gatewayCalls: string[];
let svc: MobileService;

const store: MobileStore = {
	readConfig: () => ({ ...config }),
	writeConfig: (c) => void (config = { ...c }),
	readDevices: () => devices.map((d) => ({ ...d })),
	writeDevices: (list) => {
		devices = list.map((d) => ({ ...d }));
		writes += 1;
	},
};
const tailscale: TailscaleRunner = {
	status: async () => {
		if (ts.failStatus) throw new Error("boom");
		return ts.state;
	},
	serving: async () => ts.serving,
	serve: async (port) => {
		ts.calls.push(`serve ${port}`);
		if (ts.failServe) throw new TailscaleError("Tailscale could not share the phone gateway: nope");
		ts.serving = true;
	},
	stopServing: async () => {
		ts.calls.push("off");
		ts.serving = false;
	},
};
const gateway: GatewayControl = {
	listening: () => up,
	start: async (port) => {
		gatewayCalls.push(`start ${port}`);
		up = true;
	},
	stop: async () => {
		gatewayCalls.push("stop");
		up = false;
	},
};
/** Deterministic "random": every call yields different bytes. */
const random = (n: number) => {
	const b = Buffer.alloc(n);
	for (let i = 0; i < n; i++) b[i] = (seed = (seed * 131 + 17) % 251) ;
	return b;
};

beforeEach(() => {
	clock = Date.parse("2026-11-05T10:00:00.000Z");
	seed = 1;
	config = { v: 1, enabled: false, port: 47831 };
	devices = [];
	writes = 0;
	ts = { state: READY, serving: false, calls: [] };
	up = true;
	gatewayCalls = [];
	svc = createMobileService({ store, tailscale, gateway, now: () => clock, random });
});

const pair = async (name = "Phone") => {
	const offer = await svc.createPairing();
	const out = svc.redeem(offer.code, name);
	assert.ok(out.ok);
	return out;
};

describe("a pairing code", () => {
	it("has eight characters from the alphabet, expires in ten minutes, and comes with the QR code and page address when Tailscale is ready", async () => {
		const offer = await svc.createPairing();
		assert.match(offer.code, new RegExp(`^[${PAIRING_CODE_ALPHABET}]{8}$`));
		assert.equal(offer.expiresAt, new Date(clock + PAIRING_TTL_MS).toISOString());
		assert.equal(offer.pairUrl, `https://mac.t.ts.net/m/pair?code=${offer.code}`);
		assert.ok(offer.qr && offer.qr.length >= 21 && offer.qr.every((row) => row.length === offer.qr!.length && /^[01]+$/.test(row)));
	});

	it("still works without a phone address — the code is typed — but then has no QR code", async () => {
		ts.state = { state: "needs-login", httpsReady: false };
		const offer = await svc.createPairing();
		assert.equal(offer.pairUrl, undefined);
		assert.equal(offer.qr, undefined);
		assert.ok(svc.redeem(offer.code, "x").ok);
	});

	it("needs the gateway to be up", async () => {
		up = false;
		await assert.rejects(svc.createPairing(), (e: unknown) => e instanceof MobileError && e.status === 409);
	});

	it("pairs one phone, once: the same code a second time is wrong", async () => {
		const offer = await svc.createPairing();
		const first = svc.redeem(offer.code, "Daniel's iPhone");
		assert.ok(first.ok);
		assert.equal(first.device.name, "Daniel's iPhone");
		assert.deepEqual(svc.redeem(offer.code, "again"), { ok: false, status: 403, error: "That code is wrong or has expired." });
	});

	it("is read the way it was typed (lower case, with the dash)", async () => {
		const offer = await svc.createPairing();
		const typed = `${offer.code.slice(0, 4)}-${offer.code.slice(4)}`.toLowerCase();
		assert.ok(svc.redeem(typed, "x").ok);
	});

	it("expires: ten minutes later it is wrong", async () => {
		const offer = await svc.createPairing();
		clock += PAIRING_TTL_MS;
		const out = svc.redeem(offer.code, "x");
		assert.equal(out.ok, false);
	});

	it("answers 400 for something that is not a code at all, without counting it as a guess", async () => {
		const offer = await svc.createPairing();
		for (let i = 0; i < 10; i++) assert.equal((svc.redeem("nope", "x") as { status: number }).status, 400);
		assert.ok(svc.redeem(offer.code, "x").ok);
	});

	it("burns every open code after five wrong guesses — even the right one", async () => {
		const offer = await svc.createPairing();
		for (let i = 1; i < PAIRING_MAX_FAILURES; i++) assert.equal((svc.redeem("ZZZZ-ZZZZ", "x") as { status: number }).status, 403);
		assert.equal((svc.redeem("ZZZZ-ZZZZ", "x") as { status: number }).status, 403); // the fifth
		const late = svc.redeem(offer.code, "x");
		assert.deepEqual(late, { ok: false, status: 429, error: "Too many wrong codes. Show a new code on the Mac." });
		// a new code is the way back
		const fresh = await svc.createPairing();
		assert.ok(svc.redeem(fresh.code, "x").ok);
	});

	it("keeps at most three codes open: a fourth closes the oldest", async () => {
		const [a, b, c, d] = [await svc.createPairing(), await svc.createPairing(), await svc.createPairing(), await svc.createPairing()];
		assert.equal(svc.redeem(a.code, "x").ok, false);
		for (const o of [b, c, d]) assert.ok(svc.redeem(o.code, "x").ok);
	});
});

describe("a phone's key", () => {
	it("is shown once, opens the door, and is stored only as a hash", async () => {
		const out = await pair("Daniel's iPhone");
		assert.match(out.token, /^[A-Za-z0-9_-]{43}$/);
		const stored = devices[0]!;
		assert.equal(stored.tokenHash, createHash("sha256").update(out.token).digest("hex"));
		assert.ok(!JSON.stringify(devices).includes(out.token));
		assert.equal(svc.authenticate(out.token)?.id, out.device.id);
	});

	it("refuses anything that is not a paired phone's key", async () => {
		const out = await pair();
		for (const bad of [undefined, null, "", "short", out.token.slice(1), `${out.token}x`, out.token.replace(/.$/, (c) => (c === "A" ? "B" : "A")), 42]) assert.equal(svc.authenticate(bad), null, String(bad));
	});

	it("writes lastSeenAt at most once a minute", async () => {
		const out = await pair();
		const before = writes;
		clock += 1000;
		svc.authenticate(out.token);
		const afterFirst = writes;
		for (let i = 0; i < 20; i++) {
			clock += 1000;
			svc.authenticate(out.token);
		}
		assert.equal(afterFirst, before + 1);
		assert.equal(writes, afterFirst, "no further writes within the minute");
		assert.equal(devices[0]!.lastSeenAt, new Date(Date.parse("2026-11-05T10:00:01.000Z")).toISOString());
		clock += 60_000;
		svc.authenticate(out.token);
		assert.equal(writes, afterFirst + 1);
	});

	it("is shut out the moment the learner locks the phone, and the list shows it locked", async () => {
		const one = await pair("One");
		clock += 1000;
		const two = await pair("Two");
		const locked = svc.revoke(one.device.id);
		assert.equal(locked?.revoked, true);
		assert.equal(svc.authenticate(one.token), null);
		assert.equal(svc.authenticate(two.token)?.id, two.device.id);
		assert.deepEqual((await svc.status()).devices.map((d) => [d.name, d.revoked]), [["Two", false], ["One", true]]);
		assert.equal(svc.revoke("dev_nope"), null);
	});

	it("is gone for good once the phone is taken off the list", async () => {
		const out = await pair();
		assert.equal(svc.forget(out.device.id), true);
		assert.equal(svc.authenticate(out.token), null);
		assert.equal(svc.forget(out.device.id), false);
	});
});

describe("the status", () => {
	it("puts the switch, the gateway, Tailscale, the address and the phones together", async () => {
		config.enabled = true;
		ts.serving = true;
		await pair("Phone");
		const status = await svc.status();
		assert.deepEqual({ ...status, devices: status.devices.map((d) => d.name) }, {
			enabled: true,
			port: 47831,
			listening: true,
			tailscale: READY,
			serving: true,
			url: "https://mac.t.ts.net",
			devices: ["Phone"],
		});
	});

	it("has no address until Tailscale runs with HTTPS, and does not ask about Serve when it is not running", async () => {
		ts.state = { state: "running", host: "mac.t.ts.net", httpsReady: false };
		assert.equal((await svc.status()).url, undefined);
		ts.state = { state: "needs-login", httpsReady: false };
		ts.serving = true;
		assert.equal((await svc.status()).serving, false);
		ts.failStatus = true;
		assert.equal((await svc.status()).tailscale.state, "unknown");
	});
});

describe("the switches", () => {
	it("switching on starts the gateway on the stored port and remembers it", async () => {
		up = false;
		config.port = 50123;
		const status = await svc.setEnabled(true);
		assert.deepEqual(gatewayCalls, ["start 50123"]);
		assert.equal(config.enabled, true);
		assert.equal(status.listening, true);
	});

	it("switching off stops the gateway, closes open codes and takes down only a Serve that is ours", async () => {
		const offer = await svc.createPairing();
		ts.serving = true;
		await svc.setEnabled(false);
		assert.deepEqual(gatewayCalls, ["stop"]);
		assert.deepEqual(ts.calls, ["off"]);
		assert.equal(config.enabled, false);
		up = true;
		assert.equal(svc.redeem(offer.code, "x").ok, false);

		ts.calls = [];
		ts.serving = false;
		await svc.setEnabled(false);
		assert.deepEqual(ts.calls, [], "Serve was not pointing at us, so it is left alone");
	});

	it("shares with Tailscale only when it can work, and says what is missing", async () => {
		const refuses = (message: RegExp) => assert.rejects(svc.setServing(true), (e: unknown) => e instanceof MobileError && e.status === 409 && message.test(e.message));
		ts.state = { state: "not-installed", httpsReady: false };
		await refuses(/not installed/);
		ts.state = { state: "needs-login", httpsReady: false };
		await refuses(/Sign in/);
		ts.state = { state: "running", host: "mac.t.ts.net", httpsReady: false };
		await refuses(/HTTPS/);
		ts.state = READY;
		up = false;
		await refuses(/Switch phone access on/);
		assert.deepEqual(ts.calls, [], "no command was run");
	});

	it("runs `tailscale serve` for the gateway's port when asked, and reports its failure as a bad gateway", async () => {
		const status = await svc.setServing(true);
		assert.deepEqual(ts.calls, ["serve 47831"]);
		assert.equal(status.serving, true);
		ts.failServe = true;
		await assert.rejects(svc.setServing(true), (e: unknown) => e instanceof MobileError && e.status === 502 && /could not share/.test(e.message));
		await svc.setServing(false);
		assert.equal(ts.serving, false);
	});

	it("resume starts the gateway only when the learner left it switched on", async () => {
		up = false;
		await svc.resume();
		assert.deepEqual(gatewayCalls, []);
		config.enabled = true;
		await svc.resume();
		assert.deepEqual(gatewayCalls, ["start 47831"]);
		await svc.resume();
		assert.deepEqual(gatewayCalls, ["start 47831"], "already up: left alone");
	});
});
