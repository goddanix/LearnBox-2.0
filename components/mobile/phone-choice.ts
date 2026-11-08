/**
 * What the learner ticks in "On this phone" and in the first run (Learnbox 2.0, Slices 10g/10h): which courses the
 * phone holds and, of a course, which subdecks. Pure — the boxes are in phone-course-choice.tsx.
 *
 * The choice is a map from course id to `null` (the whole course, subdecks the Mac adds later included) or to the
 * subdecks ticked; a course that is not in the map is not on the phone. A set that holds every subdeck of the course
 * counts as the whole course (and is sent as such), so ticking the last box makes a course whole again.
 */

import { topicsHeld } from "@/src/core";
import type { PhoneCatalogEntry, PhoneCatalogTopic, PhoneTopicChoice } from "@/src/core";
import { formatBytes } from "./phone-storage";

export type PhoneChoice = ReadonlyMap<string, ReadonlySet<string> | null>;
export type CourseTicks = "all" | "some" | "none";

/** What a subdeck with no name is called to the learner. */
export const NO_SUBDECK_LABEL = "No subdeck";

/** The subdecks of a course a learner can tell apart: a course has them from two on. */
export function subdecksOf(entry: PhoneCatalogEntry): readonly PhoneCatalogTopic[] | null {
	return entry.topics && entry.topics.length >= 2 ? entry.topics : null;
}

/** The choice a phone starts from: every course it holds, whole, or the subdecks it holds of a course held in part. */
export function choiceOfHeld(heldIds: readonly string[], heldTopics: Readonly<PhoneTopicChoice> = {}): PhoneChoice {
	return new Map(
		heldIds.map((id): [string, ReadonlySet<string> | null] => {
			const list = topicsHeld(heldTopics, id);
			return [id, list ? new Set(list) : null];
		}),
	);
}

/** Everything the Mac has, whole (the first run). */
export function choiceOfAll(entries: readonly PhoneCatalogEntry[]): PhoneChoice {
	return new Map(entries.map((e): [string, null] => [e.id, null]));
}

/** The names of the subdecks held of a course (empty when the course is not held or has none to tell apart). */
function heldNames(entry: PhoneCatalogEntry, choice: PhoneChoice): string[] {
	const subs = subdecksOf(entry);
	const value = choice.get(entry.id);
	if (!subs || value === undefined) return [];
	return subs.filter((t) => value === null || value.has(t.name)).map((t) => t.name);
}

export function courseTicks(entry: PhoneCatalogEntry, choice: PhoneChoice): CourseTicks {
	const value = choice.get(entry.id);
	if (value === undefined) return "none";
	const subs = subdecksOf(entry);
	if (value === null || !subs) return "all";
	const held = heldNames(entry, choice).length;
	return held === 0 ? "none" : held === subs.length ? "all" : "some";
}

export function topicTicked(entry: PhoneCatalogEntry, choice: PhoneChoice, name: string): boolean {
	return heldNames(entry, choice).includes(name);
}

/** The box of a course: whole → the course leaves; none or only part of it → the whole course comes. */
export function toggleCourse(choice: PhoneChoice, entry: PhoneCatalogEntry): PhoneChoice {
	const next = new Map(choice);
	if (courseTicks(entry, choice) === "all") next.delete(entry.id);
	else next.set(entry.id, null);
	return next;
}

/** The box of a subdeck. The last subdeck unticked takes the course off the phone; a subdeck ticked on a course that is not held brings the course with just that subdeck. */
export function toggleTopic(choice: PhoneChoice, entry: PhoneCatalogEntry, name: string): PhoneChoice {
	const subs = subdecksOf(entry);
	if (!subs || !subs.some((t) => t.name === name)) return choice;
	const names = new Set(heldNames(entry, choice));
	if (!names.delete(name)) names.add(name);
	const next = new Map(choice);
	if (names.size === 0) next.delete(entry.id);
	else next.set(entry.id, names.size === subs.length ? null : names);
	return next;
}

/** The ids of the courses to hold, in the Mac's order (a held course the Mac no longer lists drops out). */
export function chosenCourses(entries: readonly PhoneCatalogEntry[], choice: PhoneChoice): string[] {
	return entries.filter((e) => courseTicks(e, choice) !== "none").map((e) => e.id);
}

/** The subdecks to hold of the courses held in part, each in the Mac's order; a course held whole is not in it. */
export function chosenTopics(entries: readonly PhoneCatalogEntry[], choice: PhoneChoice): PhoneTopicChoice {
	const out: PhoneTopicChoice = {};
	for (const e of entries) if (courseTicks(e, choice) === "some") out[e.id] = heldNames(e, choice);
	return out;
}

export interface ChoiceCounts {
	courses: number;
	cards: number;
	mediaBytes: number;
	/** True when a course is held in part: a file two subdecks use is counted for each, so the figure is an upper bound. */
	approximate: boolean;
}

export function choiceCounts(entries: readonly PhoneCatalogEntry[], choice: PhoneChoice): ChoiceCounts {
	const counts: ChoiceCounts = { courses: 0, cards: 0, mediaBytes: 0, approximate: false };
	for (const e of entries) {
		const ticks = courseTicks(e, choice);
		if (ticks === "none") continue;
		counts.courses += 1;
		if (ticks === "all") {
			counts.cards += e.cards;
			counts.mediaBytes += e.mediaBytes;
			continue;
		}
		const names = new Set(heldNames(e, choice));
		for (const t of subdecksOf(e) ?? []) {
			if (!names.has(t.name)) continue;
			counts.cards += t.cards;
			counts.mediaBytes += t.mediaBytes;
		}
		counts.approximate = true;
	}
	return counts;
}

/** "3 courses · 1289 cards · 38 MB of pictures and sounds" for what is ticked ("up to" once a course is held in part). */
export function choiceTotal(entries: readonly PhoneCatalogEntry[], choice: PhoneChoice): string {
	const c = choiceCounts(entries, choice);
	const parts = [`${c.courses} course${c.courses === 1 ? "" : "s"}`, `${c.cards} card${c.cards === 1 ? "" : "s"}`];
	if (c.mediaBytes > 0) parts.push(`${c.approximate ? "up to " : ""}${formatBytes(c.mediaBytes)} of pictures and sounds`);
	return parts.join(" · ");
}

/** The line under a course: its cards and size and — where it has subdecks — how many of them are ticked. */
export function courseLine(entry: PhoneCatalogEntry, choice: PhoneChoice): string {
	const subs = subdecksOf(entry);
	const ticks = courseTicks(entry, choice);
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
	if (ticks !== "some" || !subs) {
		const parts = [plural(entry.cards, "card")];
		if (entry.mediaBytes > 0) parts.push(formatBytes(entry.mediaBytes));
		if (subs) parts.push(plural(subs.length, "subdeck"));
		return parts.join(" · ");
	}
	const names = new Set(heldNames(entry, choice));
	const chosen = subs.filter((t) => names.has(t.name));
	const cards = chosen.reduce((sum, t) => sum + t.cards, 0);
	const bytes = chosen.reduce((sum, t) => sum + t.mediaBytes, 0);
	const parts = [`${chosen.length} of ${plural(subs.length, "subdeck")}`, plural(cards, "card")];
	if (bytes > 0) parts.push(`up to ${formatBytes(bytes)}`);
	return parts.join(" · ");
}

export interface SubdeckChange {
	course: string;
	/** Subdeck names as the learner reads them. */
	topics: string[];
}

export interface SubdeckChanges {
	leaving: SubdeckChange[];
	arriving: SubdeckChange[];
}

const readable = (name: string): string => (name === "" ? NO_SUBDECK_LABEL.toLowerCase() : name);

/**
 * Subdecks that leave or come, of the courses that stay on the phone (a whole course leaving or coming is its own
 * line). `before` is what the phone holds now.
 */
export function subdeckChanges(entries: readonly PhoneCatalogEntry[], before: PhoneChoice, after: PhoneChoice): SubdeckChanges {
	const leaving: SubdeckChange[] = [];
	const arriving: SubdeckChange[] = [];
	for (const e of entries) {
		if (courseTicks(e, before) === "none" || courseTicks(e, after) === "none") continue;
		const was = new Set(heldNames(e, before));
		const now = new Set(heldNames(e, after));
		const gone = [...was].filter((n) => !now.has(n)).map(readable);
		const came = [...now].filter((n) => !was.has(n)).map(readable);
		if (gone.length > 0) leaving.push({ course: e.name, topics: gone });
		if (came.length > 0) arriving.push({ course: e.name, topics: came });
	}
	return { leaving, arriving };
}
