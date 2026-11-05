/**
 * Phone access — the pure rules (Learnbox 2.0, Slice 10): which requests the gateway lets through, how a pairing code
 * is read, how Tailscale's status becomes a state the Settings page can show. No I/O here; the gateway, the store
 * and the Tailscale runner are the adapters (server/mobile-gateway.ts, store/mobile.ts, server/tailscale.ts).
 */

import {
	DEVICE_NAME_DEFAULT,
	DEVICE_NAME_MAX,
	MOBILE_DEFAULT_PORT,
	MOBILE_SCHEMA,
	PAIRING_CODE_ALPHABET,
	PAIRING_CODE_LENGTH,
} from "./contracts/mobile.ts";
import type { MobileConfig, MobileDevice, MobileDeviceSummary, TailscaleState } from "./contracts/mobile.ts";
import { PHONE_LESSON_ID } from "./phone-lessons.ts";

export const DEFAULT_MOBILE_CONFIG: MobileConfig = { v: MOBILE_SCHEMA, enabled: false, port: MOBILE_DEFAULT_PORT };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored config read back: anything malformed falls back to the default (phone access stays off). */
export function cleanMobileConfig(raw: unknown): MobileConfig {
	if (!isRecord(raw)) return { ...DEFAULT_MOBILE_CONFIG };
	const port = typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port >= 1024 && raw.port <= 65535 ? raw.port : MOBILE_DEFAULT_PORT;
	return { v: MOBILE_SCHEMA, enabled: raw.enabled === true, port };
}

/** A device name typed on the phone: one line, trimmed, at most DEVICE_NAME_MAX characters; blank → "iPhone". */
export function cleanDeviceName(raw: unknown): string {
	if (typeof raw !== "string") return DEVICE_NAME_DEFAULT;
	const name = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, DEVICE_NAME_MAX).trim();
	return name || DEVICE_NAME_DEFAULT;
}

/** One stored device read back; a record that is not one is dropped, never guessed at. */
export function cleanDevice(raw: unknown): MobileDevice | null {
	if (!isRecord(raw)) return null;
	const { id, name, tokenHash, createdAt, lastSeenAt, revokedAt } = raw;
	if (typeof id !== "string" || !id || typeof tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(tokenHash)) return null;
	if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return null;
	return {
		id,
		name: cleanDeviceName(name),
		tokenHash,
		createdAt,
		...(typeof lastSeenAt === "string" ? { lastSeenAt } : {}),
		...(typeof revokedAt === "string" ? { revokedAt } : {}),
	};
}

/** The list Settings shows: newest first, never the key hash. */
export function deviceSummaries(devices: readonly MobileDevice[]): MobileDeviceSummary[] {
	return [...devices]
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.map((d) => ({
			id: d.id,
			name: d.name,
			createdAt: d.createdAt,
			...(d.lastSeenAt ? { lastSeenAt: d.lastSeenAt } : {}),
			revoked: d.revokedAt !== undefined,
		}));
}

// ─── Pairing codes ───────────────────────────────────────────────────────────

/** What the learner typed (or the QR code carried) → the stored form, or null if it cannot be a code. */
export function normalizePairingCode(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const code = input.toUpperCase().replace(/[\s-]+/g, "");
	if (code.length !== PAIRING_CODE_LENGTH) return null;
	for (const ch of code) if (!PAIRING_CODE_ALPHABET.includes(ch)) return null;
	return code;
}

/** ABCD-EFGH, for reading off a screen. */
export function formatPairingCode(code: string): string {
	const half = Math.ceil(code.length / 2);
	return `${code.slice(0, half)}-${code.slice(half)}`;
}

// ─── Tailscale ───────────────────────────────────────────────────────────────

/** `tailscale status --json` → what Settings needs. Anything unreadable is "unknown", not an error. */
export function parseTailscaleStatus(raw: unknown): TailscaleState {
	if (!isRecord(raw)) return { state: "unknown", httpsReady: false };
	const backend = typeof raw.BackendState === "string" ? raw.BackendState : "";
	const state: TailscaleState["state"] =
		backend === "Running" ? "running" : backend === "NeedsLogin" || backend === "NeedsMachineAuth" ? "needs-login" : backend === "Stopped" ? "stopped" : "unknown";
	const self = isRecord(raw.Self) ? raw.Self : {};
	const dns = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : "";
	const host = dns || undefined;
	const certs = Array.isArray(raw.CertDomains) ? raw.CertDomains.filter((d): d is string => typeof d === "string") : [];
	return { state, ...(host ? { host } : {}), httpsReady: host !== undefined && certs.includes(host) };
}

/** The address the phone opens. */
export const tailscaleUrl = (host: string): string => `https://${host}`;

/**
 * `tailscale serve status --json` → does something on this Mac already forward the tailnet's https to our gateway?
 * Tolerant of the exact layout: any web handler that proxies to 127.0.0.1/localhost on our port counts.
 */
export function serveForwardsTo(raw: unknown, port: number): boolean {
	if (!isRecord(raw) || !isRecord(raw.Web)) return false;
	const target = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}/?$`);
	for (const site of Object.values(raw.Web)) {
		if (!isRecord(site) || !isRecord(site.Handlers)) continue;
		for (const handler of Object.values(site.Handlers)) {
			if (isRecord(handler) && typeof handler.Proxy === "string" && target.test(handler.Proxy)) return true;
		}
	}
	return false;
}

// ─── What the gateway lets through ───────────────────────────────────────────

/** public: anyone who reaches the gateway (the app shell, its service worker and font hold no data) · device: needs a paired phone's key · deny: nothing. */
export type MobileRouteClass = "public" | "device" | "deny";

/**
 * Every phone-visible route, listed. Anything not here is `deny`, so a new Learnbox route is closed to the phone until
 * someone opens it on purpose. The phone studies from its own copy (10c), so it needs no study routes: it takes the
 * deck and its media, and sends its answers and card changes back (10d, 10e). Lessons (10f) are the one thing that
 * runs on the Mac: they get their own routes, which reach study lessons only (server/phone-lessons.ts).
 */
const DEVICE_ROUTES: readonly { method: string; path: string }[] = [
	{ method: "GET", path: "/api/phone/deck" },
	{ method: "POST", path: "/api/phone/sync" },
	{ method: "POST", path: "/api/phone/lesson" },
	{ method: "GET", path: "/api/phone/lessons" },
];
/** One media file by name: `/api/phone/media/<name>`, exactly one non-empty segment after the prefix. */
const MEDIA_PREFIX = ["api", "phone", "media"];
/** One lesson: `/api/phone/lesson/<id>` (read it) and `/api/phone/lesson/<id>/<what>` for the turn's wire. */
const LESSON_PREFIX = ["api", "phone", "lesson"];
const LESSON_READS: ReadonlySet<string> = new Set(["stream", "turn"]);
const LESSON_WRITES: ReadonlySet<string> = new Set(["send", "steer", "dismiss"]);

/**
 * Classify one request target. `target` is the path as it came over the wire (no query string). Anything that could
 * be read two ways — dot segments, empty segments, encoded slashes or dots, backslashes, control characters — is
 * refused outright rather than normalised: the gateway forwards exactly the string it approved.
 */
export function mobileRoute(method: string, target: string): MobileRouteClass {
	if (!target.startsWith("/")) return "deny";
	if (/[\\\u0000-\u001f\u007f]/.test(target) || /%(2e|2f|5c|00)/i.test(target)) return "deny";
	const segments = target.split("/").slice(1);
	if (segments.some((s, i) => s === "." || s === ".." || (s === "" && i < segments.length - 1))) return "deny";

	const read = method === "GET" || method === "HEAD";
	const first = segments[0];
	if (read && (first === "m" || (first === "_next" && segments[1] === "static" && segments.length > 2))) return "public";
	if (read && (target === "/favicon.ico" || target === "/sw.js")) return "public";
	// the title font (public/fonts/*.ttf): one file name, no sub-folders
	if (read && first === "fonts" && segments.length === 2 && segments[1] !== "") return "public";
	const path = target.length > 1 && target.endsWith("/") ? target.slice(0, -1) : target;
	if (method === "GET" && segments.length === 4 && MEDIA_PREFIX.every((p, i) => segments[i] === p) && segments[3] !== "") return "device";
	// a trailing slash names the same address (the table below reads the shorter ones the same way)
	const lesson = segments.at(-1) === "" ? segments.slice(0, -1) : segments;
	if (lesson.length >= 4 && LESSON_PREFIX.every((p, i) => lesson[i] === p)) {
		if (!PHONE_LESSON_ID.test(lesson[3]!)) return "deny";
		if (lesson.length === 4) return method === "GET" ? "device" : "deny";
		const what = lesson[4]!;
		if (lesson.length === 5 && ((method === "GET" && LESSON_READS.has(what)) || (method === "POST" && LESSON_WRITES.has(what)))) return "device";
		return "deny";
	}
	return DEVICE_ROUTES.some((r) => r.method === method && r.path === path) ? "device" : "deny";
}
