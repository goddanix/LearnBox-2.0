import type { CreateLanguage } from "../../core/contracts/create.ts";

/**
 * The language instruction every Create prompt carries (ported from MedAnki's
 * config.LANGUAGE_HINTS). The prompts themselves stay German — that is what
 * the material was tuned in — while the generated cards follow this hint.
 */
export const LANGUAGE_HINTS: Record<CreateLanguage, string> = {
	auto:
		"Schreibe die Karten in der Sprache der Seite: Ist der Seitentext Englisch, formuliere " +
		"auf Englisch; ist er Deutsch, auf Deutsch. Bei gemischtsprachigen Seiten zählt die " +
		"Sprache des Fließtexts. Fachbegriffe, Eigennamen und Abkürzungen bleiben unabhängig " +
		"davon in ihrer Originalform.",
	de:
		"Schreibe ALLE Karten auf Deutsch, auch wenn die Seite auf Englisch ist (sinngemäß " +
		"übersetzen; medizinische Fachbegriffe dürfen in der im Deutschen gebräuchlichen Form " +
		"stehen bleiben, z. B. lateinische Termini).",
	en:
		"Write ALL cards in English, even if the source page is in German (translate the " +
		"meaning faithfully; keep standard medical/Latin terminology as-is).",
};
