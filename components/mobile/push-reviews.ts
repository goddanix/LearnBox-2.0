/**
 * Sending the phone's answers to the Mac (Learnbox 2.0, Slice 10d): the lines the Mac does not have yet, in batches;
 * each batch is marked as sent once the Mac has taken it. Sending the same lines again is harmless (the Mac knows a
 * line it holds), so a connection that drops between the Mac's answer and the mark costs nothing.
 */

import type { PhoneSyncResult } from "@/src/core";
import type { PhoneDb } from "./phone-db";
import { jsonInit, PhoneApiError, phoneJson } from "./phone-http";

const BATCH = 2000;

/** How many answers the Mac has been told about this time. */
export async function pushReviews(db: PhoneDb): Promise<number> {
	const unsent = await db.unsentReviews();
	let sent = 0;
	for (let i = 0; i < unsent.length; i += BATCH) {
		const batch = unsent.slice(i, i + BATCH);
		const out = await phoneJson<Partial<PhoneSyncResult>>("/api/phone/sync", jsonInit({ reviews: batch }));
		if (typeof out.added !== "number") throw new PhoneApiError("The Mac sent something unexpected.", "server");
		try {
			await db.markSent(batch);
		} catch {
			throw new PhoneApiError("Could not save on this phone that the answers were sent.", "server");
		}
		sent += batch.length;
	}
	return sent;
}
