/**
 * What the phone app studies from: the study engine over the phone's own storage, or nothing yet (the first run, before
 * the Mac's deck has been taken in). `update` takes the Mac's deck in and hands back the source as it is then.
 */

import { openIndexedPhoneDb } from "./phone-db";
import type { PhoneDb } from "./phone-db";
import { startPhoneEngine } from "./phone-engine";
import type { PhoneEngine } from "./phone-engine";
import { pullDeck } from "./pull-deck";
import type { PullProgress, PullResult } from "./pull-deck";

export interface PhoneSource {
	/** null: no deck on this phone yet. */
	engine: PhoneEngine | null;
	update(onProgress: (p: PullProgress) => void): Promise<{ result: PullResult; source: PhoneSource }>;
}

export function sourceOver(db: PhoneDb, engine: PhoneEngine | null): PhoneSource {
	return {
		engine,
		async update(onProgress) {
			const result = await pullDeck(db, onProgress);
			return { result, source: sourceOver(db, await startPhoneEngine(db)) };
		},
	};
}

/** The phone's real storage. */
export async function openPhoneSource(): Promise<PhoneSource> {
	const db = await openIndexedPhoneDb();
	return sourceOver(db, await startPhoneEngine(db));
}
