/**
 * The phone gateway (Learnbox 2.0, Slice 10): a small HTTP listener on 127.0.0.1 — never on a network address —
 * that Tailscale Serve forwards the tailnet's https to. It is the ONLY door the phone has into Learnbox:
 *
 *   - `POST /m-api/pair` and `GET /m-api/me` are answered here (pairing, "is my key still good?").
 *   - Everything else is classified by core/mobile.ts `mobileRoute`: the app shell is public, listed API routes need a
 *     paired phone's key (`Authorization: Bearer …`), and every other path is a 404 — settings, API keys, billing,
 *     imports and the rest never reach the Next server from here.
 *   - What passes is forwarded to the Next server on 127.0.0.1 with the desktop capability header added by us; any
 *     such header (or cookie, or key) the phone sent is dropped first.
 *
 * The phone's key travels in a header, not a cookie: no cookie jar to be shared or lost between Safari and the
 * installed web app, and nothing a foreign page could make the browser send on its own.
 */

import * as http from "node:http";
import { mobileRoute } from "../core/mobile.ts";
import type { MobileService } from "./mobile.ts";
import { mobile } from "./mobile.ts";

export interface Upstream {
	port: number;
	/** The desktop capability the Next server expects (LH_DESKTOP_API_SECRET); absent in plain dev. */
	secret?: string;
}

export interface GatewayOptions {
	service: Pick<MobileService, "authenticate" | "redeem">;
	upstream: () => Upstream;
	/** Largest request body forwarded or read (sync uploads come in 10d). */
	maxBodyBytes?: number;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
/** Never forwarded from the phone: our own capability, credentials, and forwarding claims. */
const DROPPED = new Set(["host", "authorization", "cookie", "x-learnharness-desktop", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-learnbox-device"]);
const DEFAULT_MAX_BODY = 8 * 1_048_576;
const PAIR_BODY_MAX = 4096;

const json = (res: http.ServerResponse, status: number, body: unknown) => {
	const text = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
	res.end(text);
};

function bearer(req: http.IncomingMessage): string | undefined {
	const header = req.headers.authorization;
	const match = typeof header === "string" ? /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(header) : null;
	return match?.[1];
}

/** Read a small JSON body, or null when it is too big / not JSON. */
function readJson(req: http.IncomingMessage, limit: number): Promise<Record<string, unknown> | null> {
	return new Promise((resolve) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				// Stop keeping it; the caller answers and closes the connection, so the rest is dropped with it.
				chunks.length = 0;
				resolve(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				const value = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
				resolve(typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
			} catch {
				resolve(null);
			}
		});
		req.on("error", () => resolve(null));
	});
}

export function createGatewayServer(options: GatewayOptions): http.Server {
	const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;

	async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const raw = req.url ?? "/";
		if (!raw.startsWith("/")) return json(res, 400, { error: "Bad request." });
		const q = raw.indexOf("?");
		const target = q < 0 ? raw : raw.slice(0, q);
		const method = (req.method ?? "GET").toUpperCase();

		// Answered here, not forwarded.
		if (target === "/m-api/pair" && method === "POST") {
			const body = await readJson(req, PAIR_BODY_MAX);
			if (!body) {
				res.setHeader("Connection", "close");
				return json(res, 400, { error: "Send the pairing code as JSON: { code, name }." });
			}
			const result = options.service.redeem(body.code, body.name);
			return result.ok ? json(res, 200, { token: result.token, device: result.device }) : json(res, result.status, { error: result.error });
		}
		if (target === "/m-api/me" && method === "GET") {
			const device = options.service.authenticate(bearer(req));
			return device ? json(res, 200, { device: { id: device.id, name: device.name } }) : json(res, 401, { error: "This phone is not paired (any more)." });
		}

		const kind = mobileRoute(method, target);
		if (kind === "deny") return json(res, 404, { error: "Not found." });

		let deviceId: string | undefined;
		if (kind === "device") {
			const device = options.service.authenticate(bearer(req));
			if (!device) return json(res, 401, { error: "This phone is not paired (any more)." });
			deviceId = device.id;
		}

		const declared = Number(req.headers["content-length"] ?? 0);
		if (declared > maxBody) return json(res, 413, { error: "Too large." });

		const upstream = options.upstream();
		const headers: http.OutgoingHttpHeaders = {};
		for (const [name, value] of Object.entries(req.headers)) {
			const key = name.toLowerCase();
			if (value === undefined || HOP_BY_HOP.has(key) || DROPPED.has(key)) continue;
			headers[key] = value;
		}
		headers.host = `127.0.0.1:${upstream.port}`;
		if (upstream.secret) headers["x-learnharness-desktop"] = upstream.secret;
		if (deviceId) headers["x-learnbox-device"] = deviceId;

		const out = http.request({ host: "127.0.0.1", port: upstream.port, method, path: raw, headers }, (back) => {
			const reply: http.OutgoingHttpHeaders = {};
			for (const [name, value] of Object.entries(back.headers)) if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) reply[name] = value;
			if (target.startsWith("/api/") && !reply["cache-control"]) reply["cache-control"] = "no-store";
			res.writeHead(back.statusCode ?? 502, reply);
			back.pipe(res);
		});
		out.on("error", () => {
			if (!res.headersSent) json(res, 502, { error: "Learnbox is not answering." });
			else res.destroy();
		});
		res.on("close", () => out.destroy());

		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBody) {
				req.unpipe(out);
				out.destroy();
				if (!res.headersSent) {
					res.setHeader("Connection", "close");
					json(res, 413, { error: "Too large." });
				}
			}
		});
		req.pipe(out);
	}

	return http.createServer((req, res) => {
		handle(req, res).catch(() => {
			if (!res.headersSent) json(res, 500, { error: "Something went wrong." });
			else res.destroy();
		});
	});
}

// ─── The one listener per process ────────────────────────────────────────────

const KEY = "__lhMobileGateway";
interface Running {
	server: http.Server;
	port: number;
	listening: boolean;
}
type Holder = typeof globalThis & { [KEY]?: Running };

/** Where the Next server of this process answers (the Electron shell sets PORT; plain dev uses Next's default). */
function nextUpstream(): Upstream {
	return { port: Number(process.env.PORT) || 3000, ...(process.env.LH_DESKTOP_API_SECRET ? { secret: process.env.LH_DESKTOP_API_SECRET } : {}) };
}

/** Listen on 127.0.0.1:port (and nowhere else). Starting twice on the same port is a no-op. */
export async function startMobileGateway(port: number): Promise<void> {
	const holder = globalThis as Holder;
	const current = holder[KEY];
	if (current?.listening && current.port === port) return;
	if (current?.listening) await stopMobileGateway();
	const server = createGatewayServer({ service: mobile(), upstream: nextUpstream });
	const running: Running = { server, port, listening: false };
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	running.listening = true;
	server.on("close", () => {
		running.listening = false;
	});
	holder[KEY] = running;
}

export async function stopMobileGateway(): Promise<void> {
	const holder = globalThis as Holder;
	const current = holder[KEY];
	if (!current) return;
	current.listening = false;
	delete holder[KEY];
	await new Promise<void>((resolve) => {
		current.server.close(() => resolve());
		current.server.closeAllConnections();
	});
}
