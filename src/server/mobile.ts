/**
 * Phone access — the service (Learnbox 2.0, Slice 10): pairing, the phones' keys, and the on/off switches of the
 * gateway and of Tailscale Serve. The gateway (server/mobile-gateway.ts) asks this service who may come in; Settings
 * (app/api/mobile) asks it for the status and tells it what the learner clicked.
 *
 * A phone's key is 32 random bytes, shown to the phone once; only its SHA-256 is stored. A pairing code is eight
 * characters, valid for ten minutes and one phone, and five wrong guesses burn every open code. The pending codes and
 * the failure count live in memory only (a restart simply closes them).
 *
 * The service is ONE object per process (`mobile()`, on globalThis): Next builds the routes and the instrumentation
 * hook as separate bundles, and a revoked phone must be shut out of the gateway the moment the route says so.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mobileStore } from "../store/mobile.ts";
import {
	cleanDeviceName,
	deviceSummaries,
	normalizePairingCode,
	tailscaleUrl,
} from "../core/mobile.ts";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, PAIRING_MAX_FAILURES, PAIRING_MAX_OFFERS, PAIRING_TTL_MS } from "../core/contracts.ts";
import type { MobileDevice, MobileDeviceSummary, MobileStatus, PairingOffer, TailscaleState } from "../core/contracts.ts";
import type { MobileStore } from "../core/ports.ts";
import { qrRows } from "./mobile-qr.ts";
import { createTailscaleRunner, TailscaleError } from "./tailscale.ts";
import type { TailscaleRunner } from "./tailscale.ts";

export class MobileError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** What the service needs of the listener; the real one is server/mobile-gateway.ts. */
export interface GatewayControl {
	listening(): boolean;
	start(port: number): Promise<void>;
	stop(): Promise<void>;
}

export interface MobileDeps {
	store: MobileStore;
	tailscale: TailscaleRunner;
	gateway: GatewayControl;
	now: () => number;
	random: (bytes: number) => Buffer;
}

export type RedeemResult =
	| { ok: true; token: string; device: MobileDeviceSummary }
	| { ok: false; status: 400 | 403 | 429; error: string };

export interface MobileService {
	status(): Promise<MobileStatus>;
	/** Switch the gateway on or off (and remember it, so it starts with the app). Off also takes Tailscale Serve down, if it was ours. */
	setEnabled(enabled: boolean): Promise<MobileStatus>;
	/** The Settings button "Share with Tailscale": runs the `tailscale serve` command. */
	setServing(on: boolean): Promise<MobileStatus>;
	createPairing(): Promise<PairingOffer>;
	redeem(code: unknown, name: unknown): RedeemResult;
	/** The device behind a key, or null: unknown, malformed or locked. */
	authenticate(token: unknown): MobileDevice | null;
	/** Lock a phone: its key opens nothing from now on. Null for an unknown id. */
	revoke(id: string): MobileDeviceSummary | null;
	/** Take a phone off the list altogether. */
	forget(id: string): boolean;
	/** Start the gateway if the learner left it switched on (app start). */
	resume(): Promise<void>;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest();
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** lastSeenAt is written at most this often per phone. */
const SEEN_EVERY_MS = 60_000;

function newCode(random: (bytes: number) => Buffer): string {
	let code = "";
	// Rejection sampling: 256 is a multiple of the alphabet size (32), so a byte maps evenly.
	while (code.length < PAIRING_CODE_LENGTH) for (const b of random(PAIRING_CODE_LENGTH)) if (code.length < PAIRING_CODE_LENGTH) code += PAIRING_CODE_ALPHABET[b % PAIRING_CODE_ALPHABET.length];
	return code;
}

export function createMobileService(deps: MobileDeps): MobileService {
	const offers = new Map<string, number>(); // code → expiresAt (ms)
	let failures = 0;
	const seenAt = new Map<string, number>();

	const liveOffers = () => {
		const now = deps.now();
		for (const [code, expires] of offers) if (expires <= now) offers.delete(code);
	};

	async function tailscaleState(): Promise<TailscaleState> {
		try {
			return await deps.tailscale.status();
		} catch {
			return { state: "unknown", httpsReady: false };
		}
	}

	async function status(): Promise<MobileStatus> {
		const config = deps.store.readConfig();
		const tailscale = await tailscaleState();
		let serving = false;
		if (tailscale.state === "running") {
			try {
				serving = await deps.tailscale.serving(config.port);
			} catch {
				serving = false;
			}
		}
		const url = tailscale.host && tailscale.httpsReady ? tailscaleUrl(tailscale.host) : undefined;
		return {
			enabled: config.enabled,
			port: config.port,
			listening: deps.gateway.listening(),
			tailscale,
			serving,
			...(url ? { url } : {}),
			devices: deviceSummaries(deps.store.readDevices()),
		};
	}

	return {
		status,

		async setEnabled(enabled) {
			const config = deps.store.readConfig();
			if (enabled) {
				await deps.gateway.start(config.port);
				deps.store.writeConfig({ ...config, enabled: true });
			} else {
				deps.store.writeConfig({ ...config, enabled: false });
				offers.clear();
				await deps.gateway.stop();
				// Undo only what we did: Serve pointing at our gateway.
				try {
					if (await deps.tailscale.serving(config.port)) await deps.tailscale.stopServing();
				} catch {
					/* Tailscale gone or not answering: nothing of ours left to take down */
				}
			}
			return status();
		},

		async setServing(on) {
			const config = deps.store.readConfig();
			if (on) {
				const state = await tailscaleState();
				if (state.state === "not-installed") throw new MobileError("Tailscale is not installed on this Mac.", 409);
				if (state.state !== "running") throw new MobileError("Sign in to Tailscale on this Mac first.", 409);
				if (!state.httpsReady) throw new MobileError("Switch on HTTPS in the Tailscale admin console first (DNS → HTTPS Certificates).", 409);
				if (!deps.gateway.listening()) throw new MobileError("Switch phone access on first.", 409);
				try {
					await deps.tailscale.serve(config.port);
				} catch (e) {
					if (e instanceof TailscaleError) throw new MobileError(e.message, 502);
					throw e;
				}
			} else {
				try {
					await deps.tailscale.stopServing();
				} catch (e) {
					if (e instanceof TailscaleError) throw new MobileError(e.message, 502);
					throw e;
				}
			}
			return status();
		},

		async createPairing() {
			if (!deps.gateway.listening()) throw new MobileError("Switch phone access on first.", 409);
			liveOffers();
			while (offers.size >= PAIRING_MAX_OFFERS) offers.delete(offers.keys().next().value as string);
			let code = newCode(deps.random);
			while (offers.has(code)) code = newCode(deps.random);
			const expires = deps.now() + PAIRING_TTL_MS;
			offers.set(code, expires);
			failures = 0;
			const state = await tailscaleState();
			const base = state.host && state.httpsReady ? tailscaleUrl(state.host) : undefined;
			const pairUrl = base ? `${base}/m/pair?code=${code}` : undefined;
			return { code, expiresAt: new Date(expires).toISOString(), ...(pairUrl ? { pairUrl, qr: qrRows(pairUrl) } : {}) };
		},

		redeem(codeInput, nameInput) {
			const code = normalizePairingCode(codeInput);
			if (!code) return { ok: false, status: 400, error: "That is not a pairing code. It has eight letters and digits, like ABCD-2345." };
			liveOffers();
			if (failures >= PAIRING_MAX_FAILURES) {
				offers.clear();
				return { ok: false, status: 429, error: "Too many wrong codes. Show a new code on the Mac." };
			}
			if (!offers.has(code)) {
				failures += 1;
				if (failures >= PAIRING_MAX_FAILURES) offers.clear();
				return { ok: false, status: 403, error: "That code is wrong or has expired." };
			}
			offers.delete(code); // one phone per code
			failures = 0;
			const token = deps.random(32).toString("base64url");
			const device: MobileDevice = {
				id: `dev_${deps.random(6).toString("hex")}`,
				name: cleanDeviceName(nameInput),
				tokenHash: sha256(token).toString("hex"),
				createdAt: new Date(deps.now()).toISOString(),
			};
			deps.store.writeDevices([...deps.store.readDevices(), device]);
			return { ok: true, token, device: deviceSummaries([device])[0]! };
		},

		authenticate(token) {
			if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
			const wanted = sha256(token);
			const devices = deps.store.readDevices();
			const hit = devices.find((d) => {
				const have = Buffer.from(d.tokenHash, "hex");
				return have.length === wanted.length && timingSafeEqual(have, wanted);
			});
			if (!hit || hit.revokedAt) return null;
			const now = deps.now();
			if (now - (seenAt.get(hit.id) ?? 0) >= SEEN_EVERY_MS) {
				seenAt.set(hit.id, now);
				deps.store.writeDevices(devices.map((d) => (d.id === hit.id ? { ...d, lastSeenAt: new Date(now).toISOString() } : d)));
			}
			return hit;
		},

		revoke(id) {
			const devices = deps.store.readDevices();
			const hit = devices.find((d) => d.id === id);
			if (!hit) return null;
			const next = { ...hit, revokedAt: hit.revokedAt ?? new Date(deps.now()).toISOString() };
			deps.store.writeDevices(devices.map((d) => (d.id === id ? next : d)));
			return deviceSummaries([next])[0]!;
		},

		forget(id) {
			const devices = deps.store.readDevices();
			if (!devices.some((d) => d.id === id)) return false;
			deps.store.writeDevices(devices.filter((d) => d.id !== id));
			seenAt.delete(id);
			return true;
		},

		async resume() {
			const config = deps.store.readConfig();
			if (config.enabled && !deps.gateway.listening()) await deps.gateway.start(config.port);
		},
	};
}

// ─── The one service per process ─────────────────────────────────────────────

const KEY = "__lhMobileService";
type Holder = typeof globalThis & { [KEY]?: MobileService };

/** The process's service, made on first use. `gateway` is bound lazily so this file does not import the listener. */
export function mobile(): MobileService {
	const holder = globalThis as Holder;
	holder[KEY] ??= createMobileService({
		store: mobileStore,
		tailscale: createTailscaleRunner(),
		gateway: lazyGateway(),
		now: Date.now,
		random: (n) => randomBytes(n),
	});
	return holder[KEY];
}

function lazyGateway(): GatewayControl {
	const load = () => import("./mobile-gateway.ts");
	return {
		listening: () => gatewayListening(),
		start: async (port) => (await load()).startMobileGateway(port),
		stop: async () => (await load()).stopMobileGateway(),
	};
}

/** True while the gateway's listener is up (set by mobile-gateway.ts on globalThis, readable without importing it). */
function gatewayListening(): boolean {
	return (globalThis as { __lhMobileGateway?: { listening: boolean } }).__lhMobileGateway?.listening === true;
}
