/**
 * Card changes travelling from the phone back to the Mac (Learnbox 2.0, Slice 10e): pause, bury, edit — made on the
 * phone, offline, and taken in on the Mac when the phone next updates (or a backup file is read).
 *
 * Pure: the Mac side (server/phone-sync.ts) supplies the store. Every way in is safe to repeat — a change the Mac
 * already took in is recognised by the stamp it left on the card (`editedAt`), and the newer of two changes to the
 * same card wins: one the learner made on the phone *before* the Mac's last change to that card is left out.
 */

import type { PhoneCardAction, PhoneCardChangesResult, PhoneCardOp } from "./contracts/mobile.ts";
import { applyStudyCardChange, StudyInputError } from "./study-engine.ts";
import type { StudyStore } from "./ports.ts";

/** At most this many card changes in one upload (a phone's unsent changes are far fewer; this is a stop for junk). */
export const MAX_PHONE_OPS = 20_000;

const ACTIONS: readonly PhoneCardAction[] = ["suspend", "unsuspend", "bury", "unbury", "edit"];
const MAX_FIELD_CHARS = 200_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A change is the same change wherever a copy of it turns up. */
export const opKey = (op: PhoneCardOp): string => `${op.cardId}|${op.action}|${op.at}`;

/** One change off the wire, or null when it is not one. Fields it does not know are dropped, not kept. */
export function cleanCardOp(raw: unknown): PhoneCardOp | null {
	if (!isRecord(raw)) return null;
	const { cardId, action, at, fields } = raw;
	if (typeof cardId !== "string" || cardId === "" || cardId.length > 200) return null;
	if (typeof action !== "string" || !ACTIONS.includes(action as PhoneCardAction)) return null;
	if (typeof at !== "string" || at.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(at) || Number.isNaN(Date.parse(at))) return null;
	if (action !== "edit") return { cardId, action: action as PhoneCardAction, at };
	if (!isRecord(fields)) return null;
	const names = Object.keys(fields);
	if (names.length === 0 || names.length > 100) return null;
	const clean: Record<string, string> = {};
	for (const name of names) {
		const value = fields[name];
		if (name.length > 100 || typeof value !== "string" || value.length > MAX_FIELD_CHARS) return null;
		clean[name] = value;
	}
	return { cardId, action: "edit", at, fields: clean };
}

/** A list of changes read one by one; the ones that are not changes are counted, not guessed at. Null: not a list. */
export function cleanCardOps(raw: unknown): { ops: PhoneCardOp[]; rejected: number } | null {
	if (!Array.isArray(raw) || raw.length > MAX_PHONE_OPS) return null;
	const ops: PhoneCardOp[] = [];
	let rejected = 0;
	for (const entry of raw) {
		const clean = cleanCardOp(entry);
		if (clean) ops.push(clean);
		else rejected += 1;
	}
	return { ops, rejected };
}

/** The changes of `incoming` that `held` does not have yet, each once, in the order they were made. */
export function newOps(held: readonly PhoneCardOp[], incoming: readonly PhoneCardOp[]): PhoneCardOp[] {
	const seen = new Set(held.map(opKey));
	const fresh: PhoneCardOp[] = [];
	for (const op of incoming) {
		const key = opKey(op);
		if (seen.has(key)) continue;
		seen.add(key);
		fresh.push(op);
	}
	return fresh.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Take card changes into the Mac's cards, oldest first, so two changes to one card end the way the learner made
 * them. A change is left out when the card carries a stamp that is not older than the change: the same change taken in
 * before (`known`), or a later change made on the Mac (`newerOnMac`). Null: `raw` is not a list of changes.
 */
export function acceptPhoneOps(store: StudyStore, raw: unknown): PhoneCardChangesResult | null {
	const cleaned = cleanCardOps(raw);
	if (!cleaned) return null;
	const result: PhoneCardChangesResult = { applied: 0, known: 0, newerOnMac: 0, unknownCards: 0, rejected: cleaned.rejected };
	// `resolve` is never asked: a change rewrites card records, it renders nothing
	const deps = { store, resolve: () => null };
	for (const op of newOps([], cleaned.ops)) {
		const card = store.readCards().find((c) => c.id === op.cardId);
		if (!card) {
			result.unknownCards += 1;
			continue;
		}
		if (card.editedAt !== undefined) {
			const stamped = Date.parse(card.editedAt);
			const made = Date.parse(op.at);
			if (stamped === made) {
				result.known += 1;
				continue;
			}
			if (stamped > made) {
				result.newerOnMac += 1;
				continue;
			}
		}
		try {
			applyStudyCardChange({ cardId: op.cardId, action: op.action, fields: op.fields }, new Date(op.at), deps);
			result.applied += 1;
		} catch (e) {
			if (!(e instanceof StudyInputError)) throw e;
			result.rejected += 1;
		}
	}
	return result;
}

/** "2 card changes" — for the screens' sentences. */
export const cardChangesText = (n: number): string => `${n} card change${n === 1 ? "" : "s"}`;

/** "3 answers and 2 card changes" — what only the phone has, for the screens' sentences. */
export function describeUnsent(reviews: number, ops: number): string {
	const parts: string[] = [];
	if (reviews > 0) parts.push(`${reviews} answer${reviews === 1 ? "" : "s"}`);
	if (ops > 0) parts.push(cardChangesText(ops));
	return parts.join(" and ");
}
