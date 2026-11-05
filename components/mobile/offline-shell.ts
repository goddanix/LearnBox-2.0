/**
 * Keeping the phone app's own files for offline starts (Learnbox 2.0, Slice 10c): registers the service worker
 * (public/sw.js) and tells it which files this page used, so the very first visit is covered too.
 */

/** The shell files among what the page loaded (same site, built scripts/styles, icons, fonts), plus the page itself. */
export function shellUrls(loaded: readonly string[], origin: string, page: string): string[] {
	const out = new Set<string>([page]);
	for (const raw of loaded) {
		try {
			const url = new URL(raw, origin);
			if (url.origin !== origin) continue;
			if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/fonts/") || url.pathname.startsWith("/m/") || url.pathname === "/favicon.ico") out.add(url.pathname + url.search);
		} catch {
			/* not an address */
		}
	}
	return [...out];
}

/** Register the worker and hand it this page's files. Quietly does nothing where there is no service worker (or it is refused). */
export async function keepAppForOffline(): Promise<void> {
	try {
		if (!("serviceWorker" in navigator)) return;
		await navigator.serviceWorker.register("/sw.js", { scope: "/" });
		const reg = await navigator.serviceWorker.ready;
		const loaded = performance.getEntriesByType("resource").map((e) => e.name);
		reg.active?.postMessage({ type: "keep", urls: shellUrls(loaded, location.origin, location.pathname) });
		// ask the browser not to clear the phone's storage when it runs short of space
		await navigator.storage?.persist?.();
	} catch {
		/* the app works online all the same */
	}
}
