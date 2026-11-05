/**
 * The study engine on the phone (Learnbox 2.0, Slice 10c): the very engine the Mac runs (core/study-engine.ts) over
 * the phone's own copy of the cards. The ledgers live in memory while studying (the engine is synchronous) and every
 * answer is written through to the phone's storage before the next card is shown.
 *
 * Card pictures come from the phone's media files. The engine renders both faces of a card in one go and asks for
 * the media synchronously; so a card is first rendered with whatever is in memory, and when files were missing they
 * are read from storage and the same card is rendered again (same step, nothing recorded twice).
 */

import { createMemoryStudyStore, studyAnswer, studyCourses, studyNext, studyUndo, StudyInputError } from "@/src/core";
import type { StudyChange, StudyNextResult, StudyReview } from "@/src/core";
import type { PhoneDb, PhoneMeta } from "./phone-db";
import { PhoneApiError } from "./phone-http";
import type { PhoneStudyApi } from "./study-api";

export interface PhoneEngine {
	api: PhoneStudyApi;
	meta: PhoneMeta;
	/** Answers given on this phone that the Mac does not have yet. */
	unsent(): number;
}

/** `data:` URI for a media file; chunked, because one spread of a big array overflows the call stack. */
export function toDataUri(mime: string, bytes: ArrayBuffer): string {
	const u8 = new Uint8Array(bytes);
	let binary = "";
	for (let i = 0; i < u8.length; i += 0x8000) binary += String.fromCharCode(...u8.subarray(i, i + 0x8000));
	return `data:${mime};base64,${btoa(binary)}`;
}

/** Media kept in memory, as data: URIs, up to about this many characters (the oldest go first). */
const MEDIA_CACHE_CHARS = 24 * 1024 * 1024;

/** The engine over the phone's snapshot, or null when no deck has been taken in yet. */
export async function startPhoneEngine(db: PhoneDb, now: () => Date = () => new Date()): Promise<PhoneEngine | null> {
	const snap = await db.load();
	if (!snap) return null;

	let unsent = snap.reviews.filter((r) => !r.sent).length;
	const pending: StudyReview[] = [];
	const store = createMemoryStudyStore(
		{ courses: snap.courses, cards: snap.cards, reviews: snap.reviews.map((r) => r.review) },
		(change: StudyChange) => {
			if (change.kind === "reviews") pending.push(...change.reviews);
		},
	);

	// name → data URI (null: the phone has no such file); insertion order = age
	const cache = new Map<string, string | null>();
	let cacheChars = 0;
	const missing = new Set<string>();
	const resolve = (name: string): string | null => {
		if (cache.has(name)) return cache.get(name) ?? null;
		missing.add(name);
		return null;
	};
	const warm = async (names: readonly string[]) => {
		const files = await db.getMedia(names);
		for (const name of names) {
			const file = files.get(name);
			const uri = file ? toDataUri(file.mime, file.bytes) : null;
			cache.set(name, uri);
			cacheChars += uri?.length ?? 0;
		}
		for (const [name, uri] of cache) {
			if (cacheChars <= MEDIA_CACHE_CHARS) break;
			cache.delete(name);
			cacheChars -= uri?.length ?? 0;
		}
	};
	const deps = { store, resolve };

	/** The result, with its card's pictures in: when files were missing, the same card is rendered again once they are loaded. */
	const settled = async (courseId: string, out: StudyNextResult): Promise<StudyNextResult> => {
		if (missing.size === 0) return out;
		const names = [...missing];
		missing.clear();
		await warm(names);
		return out.card ? studyNext(courseId, out.step, now(), deps, out.card.id) : out;
	};

	/** An engine call, its answer written to storage, its failures in the screens' terms. */
	const run = async (courseId: string | null, call: () => StudyNextResult): Promise<StudyNextResult> => {
		let out: StudyNextResult;
		try {
			out = call();
		} catch (e) {
			if (e instanceof StudyInputError) throw new PhoneApiError(e.message, "server");
			throw e;
		}
		if (pending.length > 0) {
			const batch = pending.splice(0);
			try {
				await db.addReviews(batch);
				unsent += batch.length;
			} catch {
				throw new PhoneApiError("Could not save your answer on this phone.", "server");
			}
		}
		return courseId ? settled(courseId, out) : out;
	};

	const api: PhoneStudyApi = {
		courses: async () => studyCourses(now(), deps),
		next: (courseId, step, openCardId) => run(courseId, () => studyNext(courseId, step, now(), deps, openCardId)),
		answer: (input) => run(input.courseId, () => studyAnswer(input, now(), deps)),
		undo: (input) => run(input.courseId, () => studyUndo(input, now(), deps)),
	};
	return { api, meta: snap.meta, unsent: () => unsent };
}
