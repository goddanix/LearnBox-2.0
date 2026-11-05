/**
 * Answers from the phone, on the Mac (Learnbox 2.0, Slice 10d): the update's upload and a backup file read in. The
 * rules (what a line is, what is already known) are core/phone-sync.ts; this puts them on the real ledger.
 */

import type { PhoneSyncResult } from "../core/contracts/mobile.ts";
import { acceptPhoneChanges, readPhoneBackup } from "../core/phone-sync.ts";
import { defaultStudyDeps } from "./study.ts";
import type { StudyDeps } from "./study.ts";

export class PhoneSyncInputError extends Error {}

/** POST /api/phone/sync `{ reviews?: [...], ops?: [...] }` — the phone's answers and card changes; repeating the same upload adds nothing. */
export function acceptPhoneSync(body: unknown, deps: StudyDeps = defaultStudyDeps()): PhoneSyncResult {
	const lists = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { reviews?: unknown; ops?: unknown }) : {};
	const result = acceptPhoneChanges(deps.store, lists);
	if (!result) throw new PhoneSyncInputError("Send the answers as JSON: { reviews: [...], ops: [...] }.");
	return result;
}

/** A backup file the learner picked on the Mac (Settings → Phone). */
export function importPhoneBackup(file: unknown, deps: StudyDeps = defaultStudyDeps()): PhoneSyncResult {
	const read = readPhoneBackup(file);
	if (!read) throw new PhoneSyncInputError("This is not a Learnbox phone backup file.");
	const result = acceptPhoneChanges(deps.store, { reviews: read.backup.reviews, ops: read.backup.ops ?? [] });
	if (!result) throw new PhoneSyncInputError("This is not a Learnbox phone backup file.");
	return { ...result, rejected: result.rejected + read.rejected };
}
