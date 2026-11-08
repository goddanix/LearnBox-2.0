/**
 * Taking the Mac's deck onto the phone (Learnbox 2.0, Slice 10c): the courses, cards and review history first (so
 * studying can start), then the pictures and sounds the cards need, a few at a time. What the phone already holds is
 * not fetched again; what the cards no longer use is dropped.
 */

import { newReviews, readPhoneDeck, topicsHeld } from "@/src/core";
import type { PhoneDeck, PhoneTopicChoice } from "@/src/core";
import { heldCourseIds, heldTopicChoice } from "./phone-db";
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

/** The subdeck choice for the given courses only (all of it when no courses are given). */
function onlyCourses(choice: Readonly<PhoneTopicChoice>, courseIds: readonly string[] | undefined): PhoneTopicChoice {
	return Object.fromEntries(Object.entries(choice).filter(([id]) => !courseIds || courseIds.includes(id)));
}

/** Does a course now hold subdecks it did not hold before? (null = the whole course.) */
function widened(before: readonly string[] | null, after: readonly string[] | null): boolean {
	if (before === null) return false;
	return after === null || after.some((name) => !before.includes(name));
}

/**
 * Take the Mac's deck in. `courseIds` are the courses the learner wants on the phone; without them the phone keeps the
 * ones it holds (the first time: all the Mac has). Courses taken off the list leave the phone — their cards, their
 * answers the Mac already has, and the pictures only they use. `topics` narrows a course to some of its subdecks (a
 * course it does not name comes whole); with a choice of courses and no `topics` every course comes whole, and with
 * neither the phone keeps the subdecks it holds.
 */
export async function pullDeck(
	db: PhoneDb,
	onProgress: (p: PullProgress) => void = () => {},
	now: () => Date = () => new Date(),
	courseIds?: readonly string[],
	topics?: Readonly<PhoneTopicChoice>,
): Promise<PullResult> {
	onProgress({ phase: "deck", done: 0, total: 1 });
	const prior = await db.load();
	const held = prior ? heldCourseIds(prior) : null;
	const heldTopics = prior ? heldTopicChoice(prior) : {};
	const chosen = courseIds ?? held ?? undefined;
	const wantTopics = onlyCourses(topics ?? (courseIds ? {} : heldTopics), chosen);
	// A course or subdeck the phone did not hold before has answers on the Mac this phone never saw: start the ledger from the top.
	// (Lines it already has are recognised and not added twice.)
	const grew = !!chosen && !!held && chosen.some((id) => !held.includes(id) || widened(topicsHeld(heldTopics, id), topicsHeld(wantTopics, id)));
	const from = prior && !grew ? prior.meta.macReviews : 0;
	const query = `reviewsFrom=${from}${chosen ? `&courses=${chosen.map(encodeURIComponent).join(",")}` : ""}${Object.keys(wantTopics).length > 0 ? `&topics=${encodeURIComponent(JSON.stringify(wantTopics))}` : ""}`;
	const raw = await phoneJson<unknown>(`/api/phone/deck?${query}`);
	const deck: PhoneDeck | null = readPhoneDeck(raw);
	if (!deck) throw new PhoneApiError("The Mac sent something unexpected.", "server");

	const onDeck = new Set(deck.cards.map((c) => c.id));
	const fresh = newReviews(
		(prior?.reviews ?? []).map((r) => r.review),
		deck.reviews.filter((r) => onDeck.has(r.cardId)),
	);
	// what the Mac really gave: a course it no longer has drops out of the choice
	const gave = deck.courses.map((c) => c.id);
	const heldNow = onlyCourses(wantTopics, gave);
	const meta: PhoneMeta = {
		v: 1,
		deckAt: deck.at,
		syncedAt: now().toISOString(),
		macReviews: deck.reviewsTotal,
		courses: gave,
		...(Object.keys(heldNow).length > 0 ? { topics: heldNow } : {}),
		...(deck.catalog ? { catalog: deck.catalog } : {}),
	};
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
