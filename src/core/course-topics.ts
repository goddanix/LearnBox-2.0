/**
 * Subjects and their topics (Learnbox 2.0, 2026-11): the pure rules of MedAnki's courses.py and topic_assign.py —
 * a topic list out of text, the match of a new list against the topics already set, the tidy-up proposal, and the
 * assignment of cards to topics. Claude's calls and the files are in server/create-courses.ts, the prompt texts in
 * agent/create/course-prompts.ts; tests/course-topics.test.ts compares these functions with MedAnki's own output.
 */

import { cleanTopics } from "./card-util.ts";
import type { CardDraft, ProposedTopic } from "./contracts/create-cards.ts";

/** A line of a topic file longer than this is prose, not a topic. */
export const MAX_TEXT_LINE = 160;
/** Largest number of topics one new list may add to a subject that has topics already. */
export const MAX_NEW_PER_UPLOAD = 5;
/** Cards per call of the assignment to topics. */
export const ASSIGN_BATCH = 60;
/** The topic of a card that fits none. */
export const OTHER_TOPIC = "Other";
/** Topics in a tidied proposal. */
const MAX_PROPOSAL = 40;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Python's `int(x)` for what a model may put into a JSON number field; null where Python would raise. */
function toInt(v: unknown): number | null {
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
	if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10);
	return null;
}

/** Python's `str(x or "")`. */
const textOf = (v: unknown): string => (v === null || v === undefined || v === false || v === 0 || v === "" ? "" : String(v));

const chars = (s: string): string[] => [...s];

/** A topic list from text: every line a topic (bullets and numbers removed), lines that are too short or too long skipped. */
export function topicsFromText(text: string): string[] {
	const lines: string[] = [];
	for (const raw of String(text ?? "").split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/)) {
		const line = raw.replace(/^\s*(?:[-*•·▪]|\d{1,3}[.)]|[a-zA-Z][.)])\s*/, "").trim();
		const n = chars(line).length;
		if (n >= 3 && n <= MAX_TEXT_LINE) lines.push(line);
	}
	return cleanTopics(lines);
}

/** The model's answer to the match → {number of the new entry: number of the topic it belongs to, 0 = a new topic}. Unusable parts count as new. */
export function parseMatches(raw: unknown, nExisting: number, nNew: number): Map<number, number> {
	const out = new Map<number, number>();
	const list = isRecord(raw) && Array.isArray(raw.matches) ? raw.matches : [];
	for (const m of list) {
		if (!isRecord(m)) continue;
		const added = toInt(m.new);
		const existing = toInt(m.existing);
		if (added === null || existing === null) continue;
		if (added >= 1 && added <= nNew) out.set(added, existing >= 1 && existing <= nExisting ? existing : 0);
	}
	return out;
}

export interface MergedTopics {
	topics: string[];
	/** Entries that belong to a topic set already. */
	matched: number;
	/** New topics the list added. */
	added: string[];
}

/** The topics set stay (order and names unchanged); entries without a topic of theirs are added, at most `MAX_NEW_PER_UPLOAD`. */
export function mergeTopics(existing: readonly string[], extracted: readonly string[], matches: ReadonlyMap<number, number>): MergedTopics {
	const topics = [...existing];
	const seen = new Set(topics.map((t) => t.toLowerCase()));
	let matched = 0;
	const added: string[] = [];
	extracted.forEach((item, index) => {
		if ((matches.get(index + 1) ?? 0) !== 0) {
			matched++;
			return;
		}
		const key = item.toLowerCase();
		if (seen.has(key) || added.length >= MAX_NEW_PER_UPLOAD) return; // there already, or over the limit: the subject misses nothing essential
		seen.add(key);
		topics.push(item);
		added.push(item);
	});
	return { topics: cleanTopics(topics), matched, added };
}

/** The tidied proposal out of the model's answer: unique names, the source "list" or "lecture". */
export function cleanProposal(raw: unknown): ProposedTopic[] {
	const out: ProposedTopic[] = [];
	const seen = new Set<string>();
	for (const item of Array.isArray(raw) ? raw : []) {
		const [name, source] = isRecord(item) ? [item.name, item.source] : [item, "vorlesung"];
		const cleaned = cleanTopics([textOf(name)])[0];
		if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
		seen.add(cleaned.toLowerCase());
		out.push({ name: cleaned, source: String(source).toLowerCase() === "liste" ? "list" : "lecture" });
	}
	return out.slice(0, MAX_PROPOSAL);
}

/** What the model sees of a card when it assigns topics: one line of plain text. */
export function assignCardText(c: CardDraft): string {
	const text = c.type === "cloze" ? c.text : c.type === "image_occlusion" ? `${c.header} ${c.label}` : `${c.front} – ${c.back}`;
	return chars(
		text
			.replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/g, "$1")
			.split(/\s+/)
			.filter(Boolean)
			.join(" "),
	)
		.slice(0, 200)
		.join("");
}

/** The model's answer to the assignment → {card key: topic}. A card the answer leaves out, names wrongly or gives 0 goes to "Other". */
export function parseAssignments(raw: unknown, topics: readonly string[], keys: ReadonlySet<string>): Map<string, string> {
	const out = new Map<string, string>();
	for (const a of isRecord(raw) && Array.isArray(raw.assignments) ? raw.assignments : []) {
		if (!isRecord(a)) continue;
		const key = textOf(a.id);
		if (!keys.has(key)) continue;
		const n = toInt(a.topic) ?? 0;
		out.set(key, n >= 1 && n <= topics.length ? topics[n - 1]! : OTHER_TOPIC);
	}
	for (const key of keys) if (!out.has(key)) out.set(key, OTHER_TOPIC);
	return out;
}
