/**
 * Answers travelling from the phone back to the Mac (Learnbox 2.0, Slice 10d) — by the update (POST /api/phone/sync)
 * or by a backup file the learner carries over. Pure: the Mac side (server/phone-sync.ts) supplies the ledger.
 *
 * A review line is the same line wherever a copy of it turns up (core/phone-deck.ts `reviewKey`), so every way in
 * is safe to repeat: the second time, nothing is added.
 */

import { PHONE_BACKUP_KIND, PHONE_BACKUP_SCHEMA } from "./contracts/mobile.ts";
import type { PhoneBackup, PhoneSyncResult } from "./contracts/mobile.ts";
import type { StudyGrade, StudyReview } from "./contracts/study.ts";
import { newReviews } from "./phone-deck.ts";
import type { StudyStore } from "./ports.ts";

/** At most this many review lines in one upload (a phone's unsent answers are far fewer; this is a stop for junk). */
export const MAX_PHONE_REVIEWS = 100_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One review line off the wire, or null when it is not one. Fields it does not know are dropped, not kept. */
export function cleanReviewLine(raw: unknown): StudyReview | null {
	if (!isRecord(raw)) return null;
	const { cardId, at, grade, ms, undo } = raw;
	if (typeof cardId !== "string" || cardId === "" || cardId.length > 200) return null;
	if (typeof at !== "string" || at.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(at) || Number.isNaN(Date.parse(at))) return null;
	if (grade !== 1 && grade !== 2 && grade !== 3 && grade !== 4) return null;
	return {
		cardId,
		at,
		grade: grade as StudyGrade,
		...(typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? { ms } : {}),
		...(undo === true ? { undo: true as const } : {}),
	};
}

/** A list of lines read one by one; the ones that are not review lines are counted, not guessed at. Null: not a list. */
export function cleanReviewLines(raw: unknown): { reviews: StudyReview[]; rejected: number } | null {
	if (!Array.isArray(raw) || raw.length > MAX_PHONE_REVIEWS) return null;
	const reviews: StudyReview[] = [];
	let rejected = 0;
	for (const line of raw) {
		const clean = cleanReviewLine(line);
		if (clean) reviews.push(clean);
		else rejected += 1;
	}
	return { reviews, rejected };
}

/**
 * Take review lines into the Mac's ledger: only the ones it does not hold yet, and only for cards that exist (an
 * answer for a card deleted in the meantime has nothing to schedule). One write. Null: `raw` is not a list of lines.
 */
export function acceptPhoneReviews(store: StudyStore, raw: unknown): PhoneSyncResult | null {
	const cleaned = cleanReviewLines(raw);
	if (!cleaned) return null;
	const fresh = newReviews(store.readReviews(), cleaned.reviews);
	const live = new Set(store.readCards().map((c) => c.id));
	const add = fresh.filter((r) => live.has(r.cardId));
	if (add.length > 0) store.appendReviews(add);
	return {
		added: add.length,
		known: cleaned.reviews.length - fresh.length,
		unknownCards: fresh.length - add.length,
		rejected: cleaned.rejected,
		reviewsTotal: store.readReviews().length,
	};
}

// ─── the backup file ─────────────────────────────────────────────────────────

/** What the learner saves on the phone: the answers the Mac does not have yet. No cards, no pictures — it stays small. */
export function buildPhoneBackup(reviews: readonly StudyReview[], now: Date, device?: string): PhoneBackup {
	return { v: PHONE_BACKUP_SCHEMA, kind: PHONE_BACKUP_KIND, createdAt: now.toISOString(), ...(device ? { device } : {}), reviews: [...reviews] };
}

/** learnbox-backup-2026-11-05-1952.json (the phone's local time) */
export function backupFileName(now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `learnbox-backup-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

/** A backup file read back; anything that is not one of ours is null. Lines that are not review lines are counted. */
export function readPhoneBackup(raw: unknown): { backup: PhoneBackup; rejected: number } | null {
	if (!isRecord(raw) || raw.v !== PHONE_BACKUP_SCHEMA || raw.kind !== PHONE_BACKUP_KIND || typeof raw.createdAt !== "string") return null;
	const cleaned = cleanReviewLines(raw.reviews);
	if (!cleaned) return null;
	const device = typeof raw.device === "string" && raw.device.length <= 80 ? raw.device : undefined;
	return { backup: { v: PHONE_BACKUP_SCHEMA, kind: PHONE_BACKUP_KIND, createdAt: raw.createdAt, ...(device ? { device } : {}), reviews: cleaned.reviews }, rejected: cleaned.rejected };
}

/** What a sync or an imported backup did, in a sentence. */
export function syncSummary(r: PhoneSyncResult): string {
	const parts = [`${r.added} new answer${r.added === 1 ? "" : "s"} taken in`];
	if (r.known > 0) parts.push(`${r.known} already there`);
	if (r.unknownCards > 0) parts.push(`${r.unknownCards} for cards that no longer exist skipped`);
	if (r.rejected > 0) parts.push(`${r.rejected} unreadable line${r.rejected === 1 ? "" : "s"} skipped`);
	return `${parts.join(", ")}.`;
}
