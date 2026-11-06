/**
 * The Anki import, wired: read a COPY of the collection, map it
 * (core/anki-import.ts), copy the referenced media, write the study ledgers.
 * Two calls, as the owner chose to map decks by hand: `inspectAnki` shows the
 * decks and note types, `runAnkiImport` imports under the owner's plan.
 *
 * Re-running is safe: courses that exist are left alone, cards that exist
 * (same `anki_<card id>`) are left alone, reviews already in the ledger
 * (same card + instant) are not appended twice.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	ImportPlanError,
	inspectCollection,
	mapCollection,
	parseImportPlan,
	suggestPlan,
	type AnkiCandidate,
	type ImportOutcome,
	type InspectResult,
} from "../core/anki-import.ts";
import type { StudyStore } from "../core/ports.ts";
import { copyAnkiMedia, findAnkiCollections, readAnkiCollection } from "../store/anki-source.ts";
import { StudyInputError } from "./study.ts";
import { studyStore } from "../store/study.ts";

/**
 * Which deck level the suggested plan takes as the course: 1 = the first sub-deck, so `1st Year::Biology::W1` is course
 * "Biology", topic "W1" (the owner's layout: a year or semester as the top deck, the subjects below it). A deck that
 * has no sub-deck is its own course. The owner can still remap every deck in the dialog.
 */
export const SUGGESTED_SUBJECT_LEVEL = 1;

/** Anki collections found under Anki's data folder, one per profile. */
export function listAnkiCollections(base?: string): AnkiCandidate[] {
	return findAnkiCollections(base);
}

/** A request path must be an existing `.anki2` file; nothing else is ever opened. */
function collectionFile(input: unknown): string {
	if (typeof input !== "string" || input.length === 0 || !path.isAbsolute(input)) {
		throw new StudyInputError("Collection path must be absolute", 400);
	}
	if (path.extname(input).toLowerCase() !== ".anki2") {
		throw new StudyInputError("That is not an Anki collection (.anki2)", 400);
	}
	let isFile = false;
	try {
		isFile = fs.statSync(input).isFile();
	} catch {
		// falls through to the error below
	}
	if (!isFile) throw new StudyInputError("Collection file not found", 404);
	return input;
}

/** Read a collection the owner chose: the decks, the note types and a suggested plan. */
export function inspectAnki(
	collectionPath: unknown,
	now: Date = new Date(),
	store: StudyStore = studyStore,
): InspectResult {
	const file = collectionFile(collectionPath);
	let col;
	try {
		col = readAnkiCollection(file);
	} catch (err) {
		throw new StudyInputError(err instanceof Error ? err.message : "Could not read the collection", 400);
	}
	return {
		inspection: inspectCollection(col),
		suggestedPlan: suggestPlan(col, now, { subjectLevel: SUGGESTED_SUBJECT_LEVEL }),
		existingCourses: store.readCourses().map((c) => ({ id: c.id, name: c.name })),
	};
}

export interface ImportOptions {
	/** Anki's media folder; defaults to `collection.media` beside the collection. */
	mediaDir?: string;
	/** Where media is copied to; defaults to config.PATHS.studyMedia. */
	mediaDest?: string;
	store?: StudyStore;
}

export function runAnkiImport(
	collectionPath: unknown,
	rawPlan: unknown,
	options: ImportOptions = {},
): ImportOutcome {
	const store = options.store ?? studyStore;
	const file = collectionFile(collectionPath);
	let plan;
	try {
		plan = parseImportPlan(rawPlan, new Set(store.readCourses().map((c) => c.id)), new Date());
	} catch (err) {
		if (err instanceof ImportPlanError) throw new StudyInputError(err.message, 400);
		throw err;
	}
	const mediaDir = options.mediaDir ?? path.join(path.dirname(file), "collection.media");
	const mediaDest = options.mediaDest ?? PATHS.studyMedia;

	const col = readAnkiCollection(file);
	const mapped = mapCollection(col, plan);

	const haveCourses = new Set(store.readCourses().map((c) => c.id));
	const newCourses = plan.courses.filter((c) => !haveCourses.has(c.id));
	for (const c of newCourses) store.upsertCourse(c);

	const haveCards = new Set(store.readCards().map((c) => c.id));
	const newCards = mapped.cards.filter((c) => !haveCards.has(c.id));
	store.upsertCards(newCards);

	const haveReviews = new Set(store.readReviews().map((r) => `${r.cardId}|${r.at}`));
	const newReviews = mapped.reviews.filter((r) => !haveReviews.has(`${r.cardId}|${r.at}`));
	store.appendReviews(newReviews);

	const media = copyAnkiMedia(mediaDir, mapped.media, mediaDest);
	return {
		report: mapped.report,
		added: { courses: newCourses.length, cards: newCards.length, reviews: newReviews.length },
		alreadyImported: {
			cards: mapped.cards.length - newCards.length,
			reviews: mapped.reviews.length - newReviews.length,
		},
		media,
	};
}
