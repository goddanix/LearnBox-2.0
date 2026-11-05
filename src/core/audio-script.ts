/**
 * The rules of the audio summary (ported from MedAnki's audio.py): how long a script should be, what material Claude
 * gets, how a title is cut — and, new here, how a script too long for one text-to-speech request is cut into pieces at
 * the ends of sentences. Pure; the prompt is agent/create/audio-prompts.ts, the run is server/create-audio.ts.
 */

const MIN_WORDS = 700;
const MAX_WORDS = 2200;

/**
 * The target length of the script in spoken words: about 5-15 minutes, growing with the pages but capped — several whole
 * lectures together must not become an hours-long monologue (cost and listening). MedAnki's numbers.
 */
export function scriptBudget(nPages: number): number {
	return Math.max(MIN_WORDS, Math.min(MAX_WORDS, 500 + 30 * nPages));
}

/** A PDF's pages as the script sees them: the text of each page in reading order (★ marks what the original highlights). */
export interface AudioDocument {
	name: string;
	pages: readonly { page: number; text: string }[];
}

/**
 * The material: one block per document that has text ("##### Dokument: name #####", its pages as "=== Seite N ==="),
 * pages without text left out. `totalPages` counts every page of every document (it sets the length budget).
 * The German marks are MedAnki's (verbatim).
 */
export function audioMaterial(docs: readonly AudioDocument[]): { text: string; totalPages: number } {
	const blocks: string[] = [];
	let totalPages = 0;
	for (const doc of docs) {
		totalPages += doc.pages.length;
		const text = doc.pages
			.filter((p) => p.text.trim())
			.map((p) => `=== Seite ${p.page} ===\n${p.text}`)
			.join("\n\n");
		if (text.trim()) blocks.push(`##### Dokument: ${doc.name} #####\n${text}`);
	}
	return { text: blocks.join("\n\n"), totalPages };
}

/** The longest title (in characters of the text, not code units). */
const TITLE_MAX = 120;

/** A title as kept: trimmed and cut to 120 characters. */
export function clipTitle(title: string): string {
	return [...title.trim()].slice(0, TITLE_MAX).join("");
}

/** How many characters of the script go to the text-to-speech service (it bills by them). */
export const speechChars = (script: string): number => [...script].length;

/** The size of a piece when a script has to be cut: well below every limit a speech model has per request. */
export const SPEECH_PIECE = 4500;

const SENTENCE_END = /(?<=[.!?…]["')\]”’]*)\s+/u;

/**
 * The script in pieces of at most `max` characters, cut after the end of a sentence (a sentence longer than `max` at its last
 * space, or in the middle of a word when it has none). The pieces read in order are the script again, apart from the blanks
 * between them.
 */
export function splitSpeech(script: string, max: number = SPEECH_PIECE): string[] {
	const pieces: string[] = [];
	let current = "";
	const push = () => {
		if (current.trim()) pieces.push(current.trim());
		current = "";
	};
	for (const sentence of script.trim().split(SENTENCE_END)) {
		let rest = sentence.trim();
		if (!rest) continue;
		if ([...rest].length > max) {
			push();
			while ([...rest].length > max) {
				const head = [...rest].slice(0, max).join("");
				const space = head.lastIndexOf(" ");
				const cutAt = space > max / 2 ? space : head.length;
				pieces.push(rest.slice(0, cutAt).trim());
				rest = rest.slice(cutAt).trim();
			}
			current = rest;
			continue;
		}
		if (current && [...current].length + 1 + [...rest].length > max) push();
		current = current ? `${current} ${rest}` : rest;
	}
	push();
	return pieces;
}
