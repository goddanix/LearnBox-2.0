/**
 * StudyStore — the fs JSONL adapter for the study ledgers
 * (contracts/study.ts), at config.STUDY_FILES:
 *   courses.jsonl  StudyCourse | tombstone — last line for an id wins
 *   cards.jsonl    StudyCard   | tombstone — last line for an id wins
 *   reviews.jsonl  StudyReview             — pure appends, append order
 *
 * A tombstone is `{ "id": "...", "deleted": true }`; a later full record for
 * the same id revives it. A card's schedule is NOT stored: core/fsrs.ts
 * folds reviews.jsonl on every read, so nothing here ever decides it.
 *
 * Implements core/ports.ts StudyStore. data/study/* is exclusively this
 * adapter's. Reads are strict against the contract shapes: corrupt or
 * foreign lines are skipped, never guessed at (a torn append must not take
 * the home screen down). Same idioms as src/store/graph.ts: sync fs.
 * `createStudyStore(files)` takes the paths so tests run in a temp dir.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { STUDY_FILES } from "../../config.ts";
import type { StudyCard, StudyCourse, StudyReview } from "../core/contracts.ts";
import type { StudyStore } from "../core/ports.ts";

export interface StudyFiles {
	courses: string;
	cards: string;
	reviews: string;
}

interface Tombstone {
	id: string;
	deleted: true;
}

// ─── JSONL primitives ────────────────────────────────────────────────────────

function appendLines(file: string, records: readonly unknown[]): void {
	if (records.length === 0) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// One write call for the whole batch: a crash leaves at most one torn
	// final line, which the reader skips.
	fs.appendFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf-8");
}

function readRawLines(file: string): unknown[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return []; // no ledger yet
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// torn line: skip
		}
	}
	return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ─── shape guards ────────────────────────────────────────────────────────────

const isTombstone = (v: unknown): v is Tombstone =>
	isRecord(v) && isString(v.id) && v.deleted === true;

const isCourse = (v: unknown): v is StudyCourse =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.name) &&
	isNumber(v.bufferDays) &&
	isString(v.createdAt) &&
	(v.deadline === undefined || isString(v.deadline)) &&
	(v.newPerDay === undefined || isNumber(v.newPerDay));

const CARD_KINDS = new Set(["basic", "cloze", "occlusion", "mcq"]);

const isOrigin = (v: unknown): boolean => {
	if (!isRecord(v)) return false;
	switch (v.kind) {
		case "pdf":
			return isString(v.jobId) && (v.page === undefined || isNumber(v.page));
		case "graph":
			return isString(v.nodeId);
		case "anki-import":
			return isNumber(v.noteId);
		case "manual":
			return true;
		default:
			return false;
	}
};

const isCard = (v: unknown): v is StudyCard =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.courseId) &&
	isString(v.kind) &&
	CARD_KINDS.has(v.kind) &&
	isRecord(v.fields) &&
	Object.values(v.fields).every(isString) &&
	Array.isArray(v.tags) &&
	v.tags.every(isString) &&
	typeof v.core === "boolean" &&
	isOrigin(v.origin) &&
	isString(v.createdAt) &&
	(v.topic === undefined || isString(v.topic)) &&
	(v.variant === undefined || isNumber(v.variant)) &&
	(v.suspended === undefined || typeof v.suspended === "boolean") &&
	(v.buriedUntil === undefined || isString(v.buriedUntil));

const isReview = (v: unknown): v is StudyReview =>
	isRecord(v) &&
	isString(v.cardId) &&
	isString(v.at) &&
	(v.grade === 1 || v.grade === 2 || v.grade === 3 || v.grade === 4) &&
	(v.ms === undefined || isNumber(v.ms)) &&
	(v.undo === undefined || v.undo === true);

/** Fold upsert + tombstone lines: last line per id wins, a tombstone removes,
 *  first-appearance order is kept (a revived record keeps its old position). */
function foldLastWins<T extends { id: string }>(
	lines: readonly unknown[],
	isRecordLine: (v: unknown) => v is T,
): T[] {
	const byId = new Map<string, T | null>();
	for (const line of lines) {
		if (isTombstone(line)) byId.set(line.id, null);
		else if (isRecordLine(line)) byId.set(line.id, line);
	}
	const out: T[] = [];
	for (const v of byId.values()) if (v !== null) out.push(v);
	return out;
}

// ─── the port implementation ────────────────────────────────────────────────

export function createStudyStore(files: StudyFiles): StudyStore {
	return {
		upsertCourse(course) {
			appendLines(files.courses, [course]);
		},
		removeCourse(id) {
			appendLines(files.courses, [{ id, deleted: true } satisfies Tombstone]);
		},
		readCourses() {
			return foldLastWins(readRawLines(files.courses), isCourse);
		},

		upsertCard(card) {
			appendLines(files.cards, [card]);
		},
		upsertCards(cards) {
			appendLines(files.cards, cards);
		},
		removeCard(id) {
			appendLines(files.cards, [{ id, deleted: true } satisfies Tombstone]);
		},
		readCards() {
			return foldLastWins(readRawLines(files.cards), isCard);
		},

		appendReview(review) {
			appendLines(files.reviews, [review]);
		},
		appendReviews(reviews) {
			appendLines(files.reviews, reviews);
		},
		readReviews() {
			return readRawLines(files.reviews).filter(isReview);
		},
	};
}

/** The live store (data/study/*). */
export const studyStore: StudyStore = createStudyStore(STUDY_FILES);
