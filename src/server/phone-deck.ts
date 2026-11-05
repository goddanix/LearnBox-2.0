/**
 * The phone's deck, on the Mac (Learnbox 2.0, Slice 10c): the study ledgers and the media folder cut into what a
 * phone studies from offline. The rules (what goes in, how the reviews are windowed) are core/phone-deck.ts; this is
 * the file reading.
 */

import * as fs from "node:fs";
import type { PhoneDeck } from "../core/contracts/mobile.ts";
import { buildPhoneDeck } from "../core/phone-deck.ts";
import { defaultStudyDeps, mediaFile } from "./study.ts";
import type { StudyDeps } from "./study.ts";

/** The deck as it stands now; `reviewsFrom` is how many ledger lines the phone already holds. */
export function phoneDeck(reviewsFrom = 0, now: Date = new Date(), deps: StudyDeps = defaultStudyDeps()): PhoneDeck {
	return buildPhoneDeck(deps.store, (name) => mediaFile(deps.mediaDir, name)?.size ?? null, reviewsFrom, now);
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
