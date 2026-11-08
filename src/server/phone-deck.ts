/**
 * The phone's deck, on the Mac (Learnbox 2.0, Slice 10c): the study ledgers and the media folder cut into what a
 * phone studies from offline. The rules (what goes in, how the reviews are windowed) are core/phone-deck.ts; this is
 * the file reading.
 */

import * as fs from "node:fs";
import type { PhoneCatalog, PhoneDeck, PhoneTopicChoice } from "../core/contracts/mobile.ts";
import { buildPhoneDeck, phoneCatalogOf } from "../core/phone-deck.ts";
import { defaultStudyDeps, mediaFile } from "./study.ts";
import type { StudyDeps } from "./study.ts";

/**
 * The deck as it stands now; `reviewsFrom` is how many ledger lines the phone already holds, `courseIds` the courses
 * it chose (all when absent), `topicChoice` the subdecks of the courses it holds only in part.
 */
export function phoneDeck(
	reviewsFrom = 0,
	now: Date = new Date(),
	deps: StudyDeps = defaultStudyDeps(),
	courseIds?: readonly string[],
	topicChoice?: Readonly<PhoneTopicChoice>,
): PhoneDeck {
	return buildPhoneDeck(deps.store, (name) => mediaFile(deps.mediaDir, name)?.size ?? null, reviewsFrom, now, courseIds, topicChoice);
}

/** Every course with what it would put on a phone: the list the phone chooses from. */
export function phoneCatalog(deps: StudyDeps = defaultStudyDeps()): PhoneCatalog {
	return phoneCatalogOf(deps.store, (name) => mediaFile(deps.mediaDir, name)?.size ?? null);
}

/** One media file's bytes and type, or null when there is no such (safe, small enough) file. */
export function phoneMedia(name: string, deps: StudyDeps = defaultStudyDeps()): { bytes: Buffer; mime: string } | null {
	const found = mediaFile(deps.mediaDir, name);
	if (!found) return null;
	try {
		return { bytes: fs.readFileSync(found.file), mime: found.mime };
	} catch {
		return null;
	}
}
