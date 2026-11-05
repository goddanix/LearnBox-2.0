/**
 * Taking the Mac's deck onto the phone (Learnbox 2.0, Slice 10c): the courses, cards and review history first (so
 * studying can start), then the pictures and sounds the cards need, a few at a time. What the phone already holds is
 * not fetched again; what the cards no longer use is dropped.
 */

import { newReviews, readPhoneDeck } from "@/src/core";
import type { PhoneDeck } from "@/src/core";
import type { PhoneDb, PhoneMeta } from "./phone-db";
import { PhoneApiError, phoneCall, phoneJson } from "./phone-http";

export interface PullProgress {
	/** send: the phone's answers go to the Mac first (see push-reviews.ts). */
	phase: "send" | "deck" | "media";
	done: number;
	total: number;
}

export interface PullResult {
	cards: number;
	courses: number;
	/** Review lines the phone did not have yet. */
	reviews: number;
	media: number;
	/** Media files that could not be fetched this time (the next update tries them again). */
	mediaFailed: number;
}

const PARALLEL_DOWNLOADS = 3;

export async function pullDeck(db: PhoneDb, onProgress: (p: PullProgress) => void = () => {}, now: () => Date = () => new Date()): Promise<PullResult> {
	onProgress({ phase: "deck", done: 0, total: 1 });
	const prior = await db.load();
	const raw = await phoneJson<unknown>(`/api/phone/deck?reviewsFrom=${prior?.meta.macReviews ?? 0}`);
	const deck: PhoneDeck | null = readPhoneDeck(raw);
	if (!deck) throw new PhoneApiError("The Mac sent something unexpected.", "server");

	const fresh = newReviews(
		(prior?.reviews ?? []).map((r) => r.review),
		deck.reviews,
	);
	const meta: PhoneMeta = { v: 1, deckAt: deck.at, syncedAt: now().toISOString(), macReviews: deck.reviewsTotal };
	try {
		await db.applyDeck({ meta, courses: deck.courses, cards: deck.cards, macReviews: fresh });
	} catch {
		throw new PhoneApiError("Could not save the cards on this phone (is its storage full?).", "server");
	}
	onProgress({ phase: "deck", done: 1, total: 1 });

	// media: fetch what is missing, drop what no card asks for any more
	const have = new Set(await db.mediaNames());
	const want = new Set(deck.media.map((m) => m.name));
	await db.deleteMedia([...have].filter((n) => !want.has(n)));
	const todo = deck.media.filter((m) => !have.has(m.name));
	let done = 0;
	let failed = 0;
	onProgress({ phase: "media", done, total: todo.length });
	const queue = [...todo];
	const worker = async () => {
		for (let m = queue.shift(); m; m = queue.shift()) {
			try {
				const res = await phoneCall(`/api/phone/media/${encodeURIComponent(m.name)}`);
				await db.putMedia({ name: m.name, mime: res.headers.get("content-type") ?? "application/octet-stream", bytes: await res.arrayBuffer() });
			} catch (e) {
				// a lost connection or a locked phone ends the update; one file that will not come is skipped
				if (e instanceof PhoneApiError && e.kind !== "server") throw e;
				failed += 1;
			}
			done += 1;
			onProgress({ phase: "media", done, total: todo.length });
		}
	};
	await Promise.all(Array.from({ length: PARALLEL_DOWNLOADS }, worker));
	return { cards: deck.cards.length, courses: deck.courses.length, reviews: fresh.length, media: todo.length - failed, mediaFailed: failed };
}
