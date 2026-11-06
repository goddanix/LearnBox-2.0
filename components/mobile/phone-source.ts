/**
 * What the phone app studies from: the study engine over the phone's own storage, or nothing yet (the first run, before
 * the Mac's deck has been taken in). `update` sends the phone's answers and card changes to the Mac and takes its deck
 * in; `restore` reads the answers and card changes of a backup file in. Both hand back the source as it is then.
 */

import type { PhoneCardOp, StudyReview } from "@/src/core";
import { openIndexedPhoneDb } from "./phone-db";
import type { PhoneDb } from "./phone-db";
import { startPhoneEngine } from "./phone-engine";
import type { PhoneEngine } from "./phone-engine";
import { pullDeck } from "./pull-deck";
import type { PullProgress, PullResult } from "./pull-deck";
import { pushChanges } from "./push-changes";

export interface UpdateResult extends PullResult {
	/** Answers from this phone the Mac was told about. */
	sent: number;
	/** Card changes from this phone the Mac was told about. */
	sentOps: number;
	/** Of those, the ones the Mac left out because it had a newer change to the card. */
	newerOnMac: number;
}

/** What a backup file brought that this phone did not hold yet. */
export interface RestoreResult {
	added: number;
	addedOps: number;
}

export interface PhoneSource {
	/** null: no deck on this phone yet. */
	engine: PhoneEngine | null;
	/** `courseIds`: the courses to hold on the phone from now on (without them: the ones it holds, or all on the first run). */
	update(onProgress: (p: PullProgress) => void, courseIds?: readonly string[]): Promise<{ result: UpdateResult; source: PhoneSource }>;
	restore(backup: { reviews: readonly StudyReview[]; ops?: readonly PhoneCardOp[] }): Promise<RestoreResult & { source: PhoneSource }>;
}

export function sourceOver(db: PhoneDb, engine: PhoneEngine | null): PhoneSource {
	return {
		engine,
		async update(onProgress, courseIds) {
			// the answers and card changes first: if the Mac cannot be reached nothing else is attempted, and nothing is lost
			if (engine && engine.unsent() + engine.unsentOps().length > 0) onProgress({ phase: "send", done: 0, total: 1 });
			const pushed = await pushChanges(db);
			const result = await pullDeck(db, onProgress, undefined, courseIds);
			return {
				result: { ...result, sent: pushed.reviews, sentOps: pushed.ops, newerOnMac: pushed.cardChanges.newerOnMac },
				source: sourceOver(db, await startPhoneEngine(db)),
			};
		},
		async restore(backup) {
			const added = await db.importReviews(backup.reviews);
			const addedOps = await db.importOps(backup.ops ?? []);
			return { added, addedOps, source: sourceOver(db, await startPhoneEngine(db)) };
		},
	};
}

/** The phone's real storage. */
export async function openPhoneSource(): Promise<PhoneSource> {
	const db = await openIndexedPhoneDb();
	return sourceOver(db, await startPhoneEngine(db));
}
