/**
 * What the phone app studies from: the study engine over the phone's own storage, or nothing yet (the first run, before
 * the Mac's deck has been taken in). `update` sends the phone's answers to the Mac and takes its deck in; `restore`
 * reads the answers of a backup file in. Both hand back the source as it is then.
 */

import type { StudyReview } from "@/src/core";
import { openIndexedPhoneDb } from "./phone-db";
import type { PhoneDb } from "./phone-db";
import { startPhoneEngine } from "./phone-engine";
import type { PhoneEngine } from "./phone-engine";
import { pullDeck } from "./pull-deck";
import type { PullProgress, PullResult } from "./pull-deck";
import { pushReviews } from "./push-reviews";

export interface UpdateResult extends PullResult {
	/** Answers from this phone the Mac was told about. */
	sent: number;
}

export interface PhoneSource {
	/** null: no deck on this phone yet. */
	engine: PhoneEngine | null;
	update(onProgress: (p: PullProgress) => void): Promise<{ result: UpdateResult; source: PhoneSource }>;
	restore(reviews: readonly StudyReview[]): Promise<{ added: number; source: PhoneSource }>;
}

export function sourceOver(db: PhoneDb, engine: PhoneEngine | null): PhoneSource {
	return {
		engine,
		async update(onProgress) {
			// the answers first: if the Mac cannot be reached nothing else is attempted, and nothing is lost
			if (engine && engine.unsent() > 0) onProgress({ phase: "send", done: 0, total: 1 });
			const sent = await pushReviews(db);
			const result = await pullDeck(db, onProgress);
			return { result: { ...result, sent }, source: sourceOver(db, await startPhoneEngine(db)) };
		},
		async restore(reviews) {
			const added = await db.importReviews(reviews);
			return { added, source: sourceOver(db, await startPhoneEngine(db)) };
		},
	};
}

/** The phone's real storage. */
export async function openPhoneSource(): Promise<PhoneSource> {
	const db = await openIndexedPhoneDb();
	return sourceOver(db, await startPhoneEngine(db));
}
