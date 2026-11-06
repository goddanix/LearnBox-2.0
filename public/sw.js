/*
 * Learnbox phone app: keeps the app's own files so it starts without a connection (Learnbox 2.0, Slice 10c).
 *
 * Only the app shell is kept: the phone pages (/m, /m/*), the built scripts and styles (/_next/static/*), the title
 * font and the icons. Never /api/* or /m-api/*: the cards, the answers and the phone's key belong to the page (its
 * own storage), not to this file, and nothing private is ever put in this cache.
 *
 *   page loads   network first (a new version of the app arrives as soon as the Mac answers), the last good copy
 *                when it does not answer within a few seconds — keyed by path, so a pairing link's code is not stored.
 *                A Mac that is asleep or off the tailnet makes a request hang for a minute; the app must not.
 *   scripts etc  cache first (their names change with every build); other shell files: kept copy now, fresh one next time
 *   the page can ask for files to be kept (message {type: "keep", urls}), so the very first visit is covered too
 */
const CACHE = "learnbox-shell-v1";
/** How long a page waits for the Mac before the kept copy is shown (the request goes on and refreshes the copy). */
const NETWORK_WAIT_MS = 3000;

function inShell(url) {
	if (url.origin !== self.location.origin) return false;
	const p = url.pathname;
	return p === "/m" || p.startsWith("/m/") || p.startsWith("/_next/static/") || p.startsWith("/fonts/") || p === "/favicon.ico";
}
/** One page = one entry, whatever the query string says. */
const pageKey = (url) => url.origin + url.pathname;

self.addEventListener("install", () => {
	void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
			await self.clients.claim();
		})(),
	);
});

async function page(request, url, event) {
	const cache = await caches.open(CACHE);
	const kept = async () => (await cache.match(pageKey(url))) || (await cache.match(url.origin + "/m"));
	const network = fetch(request).then(async (res) => {
		if (res.ok) await cache.put(pageKey(url), res.clone());
		return res;
	});
	let timer;
	const late = new Promise((resolve) => {
		timer = setTimeout(() => resolve(null), NETWORK_WAIT_MS);
	});
	try {
		const res = await Promise.race([network, late]);
		clearTimeout(timer);
		if (res === null) {
			// no answer yet: the kept copy now, and the request carries on to refresh it
			const copy = await kept();
			if (copy) {
				if (event && event.waitUntil) event.waitUntil(network.catch(() => {}));
				return copy;
			}
			return await network;
		}
		if (res.ok) return res;
		// the Mac's server is down (the gateway answers 502): a kept copy is better than its error
		return (await kept()) || res;
	} catch (e) {
		clearTimeout(timer);
		const copy = await kept();
		if (copy) return copy;
		throw e;
	}
}

async function asset(request, url) {
	const cache = await caches.open(CACHE);
	const kept = await cache.match(request);
	const fresh = () =>
		fetch(request).then((res) => {
			if (res.ok) void cache.put(request, res.clone());
			return res;
		});
	if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/fonts/")) return kept || fresh();
	if (kept) {
		void fresh().catch(() => {});
		return kept;
	}
	return fresh();
}

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (!inShell(url)) return;
	if (request.mode === "navigate") {
		if (url.pathname !== "/m" && !url.pathname.startsWith("/m/")) return;
		event.respondWith(page(request, url, event));
		return;
	}
	// a client-side navigation asks for page data (?_rsc=…); that is not a file to keep
	if (url.searchParams.has("_rsc")) return;
	event.respondWith(asset(request, url));
});

self.addEventListener("message", (event) => {
	const data = event.data;
	if (!data || data.type !== "keep" || !Array.isArray(data.urls)) return;
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			for (const raw of data.urls.slice(0, 200)) {
				try {
					const url = new URL(String(raw), self.location.origin);
					if (!inShell(url)) continue;
					const isPage = url.pathname === "/m" || (url.pathname.startsWith("/m/") && /\/[^/.]+$/.test(url.pathname));
					const key = isPage ? pageKey(url) : url.href;
					if (await cache.match(key)) continue;
					const res = await fetch(isPage ? new Request(url.origin + url.pathname, { headers: { Accept: "text/html" } }) : url.href);
					if (res.ok) await cache.put(key, res);
				} catch {
					/* offline or refused: the next visit tries again */
				}
			}
		})(),
	);
});
