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

import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	inspectCollection,
	mapCollection,
	suggestPlan,
	type AnkiInspection,
	type ImportPlan,
	type ImportReport,
} from "../core/anki-import.ts";
import type { StudyStore } from "../core/ports.ts";
import { copyAnkiMedia, readAnkiCollection, type MediaCopyResult } from "../store/anki-source.ts";
import { studyStore } from "../store/study.ts";

export interface InspectResult {
	inspection: AnkiInspection;
	/** A starting point for the deck → course mapping the owner edits. */
	suggestedPlan: ImportPlan;
}

export function inspectAnki(collectionPath: string, now: Date = new Date()): InspectResult {
	const col = readAnkiCollection(collectionPath);
	return { inspection: inspectCollection(col), suggestedPlan: suggestPlan(col, now) };
}

export interface ImportOutcome {
	report: ImportReport;
	added: { courses: number; cards: number; reviews: number };
	alreadyImported: { cards: number; reviews: number };
	media: MediaCopyResult;
}

export interface ImportOptions {
	/** Anki's media folder; defaults to `collection.media` beside the collection. */
	mediaDir?: string;
	/** Where media is copied to; defaults to config.PATHS.studyMedia. */
	mediaDest?: string;
	store?: StudyStore;
}

export function runAnkiImport(
	collectionPath: string,
	plan: ImportPlan,
	options: ImportOptions = {},
): ImportOutcome {
	const store = options.store ?? studyStore;
	const mediaDir = options.mediaDir ?? path.join(path.dirname(collectionPath), "collection.media");
	const mediaDest = options.mediaDest ?? PATHS.studyMedia;

	const col = readAnkiCollection(collectionPath);
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
