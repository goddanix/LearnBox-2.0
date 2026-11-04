/**
 * The settings of a cards job (Learnbox 2.0, 2026-11): the request's body over the defaults, every field
 * checked (the body is untrusted). Mirrors MedAnki's job settings without what a later slice owns (deck, course).
 */

import { cleanTopics } from "./card-util.ts";
import { CARD_DENSITIES, CARD_IO_MODES, CARD_KINDS, CARD_LATIN_MODES, DEFAULT_CARD_SETTINGS, type CardSettings } from "./contracts/create-cards.ts";
import { CREATE_LANGUAGES } from "./contracts/create.ts";
import { int } from "./create.ts";

const pick = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => ((list as readonly unknown[]).includes(v) ? (v as T) : fallback);

export function cleanCardSettings(raw: unknown): CardSettings {
	const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const d = DEFAULT_CARD_SETTINGS;
	const model = typeof r.model === "string" ? r.model.trim() : "";
	const vocabLang = typeof r.vocabLang === "string" ? r.vocabLang.replace(/\s+/g, " ").trim() : "";
	return {
		model: /^[\w.\-[\]]{2,60}$/.test(model) ? model : d.model,
		density: pick(CARD_DENSITIES, r.density, d.density),
		language: pick(CREATE_LANGUAGES, r.language, d.language),
		ioMode: pick(CARD_IO_MODES, r.ioMode, d.ioMode),
		latinTerms: pick(CARD_LATIN_MODES, r.latinTerms, d.latinTerms),
		wholeImageCards: r.wholeImageCards === true,
		focusTopics: cleanTopics(r.focusTopics),
		focusStrict: r.focusStrict === true,
		kind: pick(CARD_KINDS, r.kind, d.kind),
		vocab: r.vocab === true,
		vocabLang: vocabLang && vocabLang.length <= 40 ? vocabLang : d.vocabLang,
		pageFrom: int(r.pageFrom, d.pageFrom, 1, 100_000),
		pageTo: int(r.pageTo, d.pageTo, 0, 100_000),
		concurrency: int(r.concurrency, d.concurrency, 1, 4),
	};
}
