/**
 * The phone app's service worker (Learnbox 2.0, Slice 10c): public/sw.js is run in a sandbox with a fake cache and a
 * fake network, and asked what a phone asks it — pages, scripts, API calls, a Mac that is down.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { describe, it } from "node:test";
import { shellUrls } from "../components/mobile/offline-shell.ts";

const ORIGIN = "https://mac.tail1234.ts.net";
const SOURCE = fs.readFileSync(path.join(import.meta.dirname, "..", "public", "sw.js"), "utf8");

type Listener = (event: Record<string, unknown>) => void;

/** The worker, loaded fresh: its listeners, a fake cache, and a network the test controls. */
function load(network: (req: Request) => Promise<Response>) {
	const listeners = new Map<string, Listener>();
	const stores = new Map<string, Map<string, Response>>();
	const keyOf = (r: Request | string) => (typeof r === "string" ? r : r.url);
	const open = async (name: string) => {
		const m = stores.get(name) ?? new Map<string, Response>();
		stores.set(name, m);
		return {
			match: async (r: Request | string) => m.get(keyOf(r))?.clone(),
			put: async (r: Request | string, res: Response) => void m.set(keyOf(r), res),
		};
	};
	const fetched: string[] = [];
	const self = {
		location: { origin: ORIGIN },
		addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
		skipWaiting: async () => {},
		clients: { claim: async () => {} },
	};
	vm.runInNewContext(SOURCE, {
		self,
		caches: { open, keys: async () => [...stores.keys()], delete: async (n: string) => stores.delete(n) },
		fetch: (input: Request | string) => {
			const req = typeof input === "string" ? new Request(input) : input;
			fetched.push(req.url);
			return network(req);
		},
		Request,
		Response,
		URL,
		console,
	});

	/** A GET (or other) request the way the browser raises it; the answer is what the worker responds with, or "ignored". */
	async function ask(url: string, init: { method?: string; mode?: RequestMode } = {}): Promise<Response | "ignored"> {
		const request = new Request(ORIGIN + url, { method: init.method ?? "GET" });
		Object.defineProperty(request, "mode", { value: init.mode ?? "no-cors" });
		let answer: Promise<Response> | undefined;
		listeners.get("fetch")!({ request, respondWith: (p: Promise<Response>) => (answer = p) });
		return answer ? answer : "ignored";
	}
	async function message(data: unknown) {
		let work: Promise<void> | undefined;
		listeners.get("message")!({ data, waitUntil: (p: Promise<void>) => (work = p) });
		await work;
	}
	return { ask, message, stores, fetched, listeners };
}

const html = (text: string) => new Response(text, { headers: { "content-type": "text/html" } });
const ok = (text = "x") => new Response(text);
const text = async (r: Response | "ignored") => (r === "ignored" ? r : r.text());
const down = async (): Promise<Response> => {
	throw new TypeError("Failed to fetch");
};

describe("what the worker looks after", () => {
	it("leaves everything that is not the app shell to the browser — API calls, the phone's key, other sites, writes", async () => {
		const sw = load(async () => ok());
		for (const url of ["/api/phone/deck", "/api/phone/media/a.png", "/m-api/me", "/m-api/pair", "/api/study/next", "/", "/settings", "/study", "/m2", "/_next/data/x.json", "/sw.js"]) {
			assert.equal(await sw.ask(url), "ignored", url);
		}
		assert.equal(await sw.ask("/m/pair", { method: "POST" }), "ignored", "only reads");
		assert.equal(await sw.ask("/m?_rsc=abc"), "ignored", "page data of a client-side navigation is not a file");
		assert.deepEqual(sw.fetched, []);
	});

	it("takes the app's pages, scripts, fonts and icons", async () => {
		const sw = load(async () => ok());
		for (const [url, mode] of [["/m", "navigate"], ["/m/pair", "navigate"], ["/_next/static/chunks/a.js", "no-cors"], ["/fonts/cmunbx.ttf", "no-cors"], ["/m/icon-192.png", "no-cors"], ["/m/manifest.webmanifest", "no-cors"], ["/favicon.ico", "no-cors"]] as const) {
			assert.notEqual(await sw.ask(url, { mode }), "ignored", url);
		}
	});

	it("does not take a navigation to a page outside the phone app", async () => {
		const sw = load(async () => ok());
		assert.equal(await sw.ask("/favicon.ico", { mode: "navigate" }), "ignored");
		assert.equal(await sw.ask("/_next/static/chunks/a.js", { mode: "navigate" }), "ignored");
	});
});

describe("pages", () => {
	it("come from the Mac when it answers, and the answer is kept", async () => {
		let version = "one";
		const sw = load(async () => html(`page ${version}`));
		assert.equal(await text(await sw.ask("/m", { mode: "navigate" })), "page one");
		version = "two";
		assert.equal(await text(await sw.ask("/m", { mode: "navigate" })), "page two", "the new version wins as soon as the Mac answers");
	});

	it("come from the kept copy when there is no connection", async () => {
		let online = true;
		const sw = load(async () => (online ? html("the app") : down()));
		await sw.ask("/m", { mode: "navigate" });
		online = false;
		assert.equal(await text(await sw.ask("/m", { mode: "navigate" })), "the app");
	});

	it("come from the kept copy when the Mac's server is down (the gateway says 502), and the error shows only if nothing is kept", async () => {
		let up = false;
		const sw = load(async () => (up ? html("the app") : new Response("{}", { status: 502 })));
		assert.equal((await sw.ask("/m", { mode: "navigate" })) instanceof Response && ((await sw.ask("/m", { mode: "navigate" })) as Response).status, 502, "nothing kept yet");
		up = true;
		await sw.ask("/m", { mode: "navigate" });
		up = false;
		assert.equal(await text(await sw.ask("/m", { mode: "navigate" })), "the app");
	});

	it("start the app from /m when the one asked for was never kept — the home-screen icon opens with no connection", async () => {
		let online = true;
		const sw = load(async () => (online ? html("the app") : down()));
		await sw.ask("/m", { mode: "navigate" });
		online = false;
		assert.equal(await text(await sw.ask("/m/pair", { mode: "navigate" })), "the app");
	});

	it("are kept by path: a pairing code in the address is not stored", async () => {
		const sw = load(async () => html("pair page"));
		await sw.ask("/m/pair?code=ABCD2345", { mode: "navigate" });
		const keys = [...[...sw.stores.values()][0]!.keys()];
		assert.deepEqual(keys, [`${ORIGIN}/m/pair`]);
	});

	it("fail when there is neither a connection nor a kept copy", async () => {
		const sw = load(down);
		await assert.rejects(async () => sw.ask("/m", { mode: "navigate" }).then((r) => (r === "ignored" ? r : r.text())), /Failed to fetch/);
	});
});

describe("scripts and other files", () => {
	it("are fetched once and then served from the cache — built files never change under one name", async () => {
		const sw = load(async () => ok("chunk"));
		assert.equal(await text(await sw.ask("/_next/static/chunks/a.js")), "chunk");
		assert.equal(await text(await sw.ask("/_next/static/chunks/a.js")), "chunk");
		assert.deepEqual(sw.fetched, [`${ORIGIN}/_next/static/chunks/a.js`]);
	});

	it("do not keep a file the Mac refused", async () => {
		const sw = load(async () => new Response("no", { status: 404 }));
		await sw.ask("/_next/static/chunks/missing.js");
		await sw.ask("/_next/static/chunks/missing.js");
		assert.equal(sw.fetched.length, 2);
	});

	it("show the kept icon at once and refresh it for next time", async () => {
		let body = "old icon";
		const sw = load(async () => ok(body));
		assert.equal(await text(await sw.ask("/m/icon-192.png")), "old icon");
		body = "new icon";
		assert.equal(await text(await sw.ask("/m/icon-192.png")), "old icon");
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(await text(await sw.ask("/m/icon-192.png")), "new icon");
	});
});

describe("files the page asks to keep", () => {
	it("are fetched and kept once; a file outside the shell, another site or a broken address is skipped", async () => {
		const sw = load(async (req) => (req.url.endsWith("/m") ? html("the app") : ok("file")));
		await sw.message({
			type: "keep",
			urls: ["/m", "/_next/static/chunks/a.js", "/m/icon-192.png", "/api/phone/deck", "https://evil.example/_next/static/x.js", "/settings", "http://[bad"],
		});
		assert.deepEqual(
			sw.fetched.sort(),
			[`${ORIGIN}/m`, `${ORIGIN}/m/icon-192.png`, `${ORIGIN}/_next/static/chunks/a.js`].sort(),
		);
		await sw.message({ type: "keep", urls: ["/_next/static/chunks/a.js", "/m"] });
		assert.equal(sw.fetched.length, 3, "nothing is fetched twice");
		// the page is served offline after the first visit
		const offline = load(down);
		assert.equal(offline.fetched.length, 0);
	});

	it("make the first visit work offline: the page asked for its files, then the connection went", async () => {
		let online = true;
		const sw = load(async (req) => (online ? (req.url.endsWith("/m") ? html("the app") : ok("file")) : down()));
		await sw.message({ type: "keep", urls: ["/m", "/_next/static/chunks/a.js"] });
		online = false;
		assert.equal(await text(await sw.ask("/m", { mode: "navigate" })), "the app");
		assert.equal(await text(await sw.ask("/_next/static/chunks/a.js")), "file");
	});

	it("ignore messages that are not a list of files", async () => {
		const sw = load(async () => ok());
		for (const data of [null, "keep", { type: "other" }, { type: "keep" }, { type: "keep", urls: "x" }]) await sw.message(data).catch(() => {});
		assert.deepEqual(sw.fetched, []);
	});
});

describe("old versions", () => {
	it("are cleared when a new worker takes over", async () => {
		const sw = load(async () => ok());
		sw.stores.set("learnbox-shell-v0", new Map());
		await new Promise<void>((resolve) => sw.listeners.get("activate")!({ waitUntil: (p: Promise<void>) => void p.then(resolve) }));
		assert.equal(sw.stores.has("learnbox-shell-v0"), false);
	});
});

describe("telling the worker which files the page used", () => {
	it("is the page itself plus built files, fonts and icons of this site — nothing from the API, nothing foreign", () => {
		const loaded = [
			`${ORIGIN}/_next/static/chunks/a.js`,
			`${ORIGIN}/_next/static/css/b.css?v=1`,
			`${ORIGIN}/fonts/cmunbx.ttf`,
			`${ORIGIN}/m/icon-192.png`,
			`${ORIGIN}/api/phone/deck?reviewsFrom=0`,
			`${ORIGIN}/m-api/me`,
			"https://cdn.example/x.js",
			"not an address %%",
		];
		assert.deepEqual(shellUrls(loaded, ORIGIN, "/m"), ["/m", "/_next/static/chunks/a.js", "/_next/static/css/b.css?v=1", "/fonts/cmunbx.ttf", "/m/icon-192.png"]);
		assert.deepEqual(shellUrls([], ORIGIN, "/m"), ["/m"]);
	});
});
