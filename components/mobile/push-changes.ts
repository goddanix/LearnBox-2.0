/**
 * Sending what only the phone has to the Mac (Learnbox 2.0, Slices 10d/10e): the answers and the card changes the Mac
 * does not have yet, in batches; each batch is marked as sent once the Mac has taken it. Sending the same things again
 * is harmless (the Mac knows a line it holds and a change it took in), so a connection that drops between the Mac's
 * answer and the mark costs nothing.
 */

import type { PhoneCardChangesResult, PhoneCardOp, PhoneSyncResult, StudyReview } from "@/src/core";
import type { PhoneDb } from "./phone-db";
import { jsonInit, PhoneApiError, phoneJson } from "./phone-http";

const BATCH = 2000;

export interface PushResult {
	/** Answers the Mac has been told about this time. */
	reviews: number;
	/** Card changes the Mac has been told about this time. */
	ops: number;
	/** What the Mac did with the card changes, added up over the batches. */
	cardChanges: PhoneCardChangesResult;
}

const unexpected = () => new PhoneApiError("The Mac sent something unexpected.", "server");
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

async function post(body: { reviews: StudyReview[] } | { ops: PhoneCardOp[] }): Promise<PhoneSyncResult> {
	const out = await phoneJson<Partial<PhoneSyncResult>>("/api/phone/sync", jsonInit(body));
	const c = out.cardChanges;
	if (!isCount(out.added) || !c || !isCount(c.applied) || !isCount(c.known) || !isCount(c.newerOnMac) || !isCount(c.unknownCards) || !isCount(c.rejected)) throw unexpected();
	return out as PhoneSyncResult;
}

export async function pushChanges(db: PhoneDb): Promise<PushResult> {
	const result: PushResult = { reviews: 0, ops: 0, cardChanges: { applied: 0, known: 0, newerOnMac: 0, unknownCards: 0, rejected: 0 } };

	const lines = await db.unsentReviews();
	for (let i = 0; i < lines.length; i += BATCH) {
		const batch = lines.slice(i, i + BATCH);
		await post({ reviews: batch });
		try {
			await db.markSent(batch);
		} catch {
			throw new PhoneApiError("Could not save on this phone that the answers were sent.", "server");
		}
		result.reviews += batch.length;
	}

	const changes = await db.unsentOps();
	for (let i = 0; i < changes.length; i += BATCH) {
		const batch = changes.slice(i, i + BATCH);
		const out = await post({ ops: batch });
		try {
			await db.markOpsSent(batch);
		} catch {
			throw new PhoneApiError("Could not save on this phone that the card changes were sent.", "server");
		}
		result.ops += batch.length;
		for (const key of Object.keys(result.cardChanges) as (keyof PhoneCardChangesResult)[]) result.cardChanges[key] += out.cardChanges[key];
	}
	return result;
}
