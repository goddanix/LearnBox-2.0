/**
 * The drafts of a subject across its PDFs (Learnbox 2.0, 2026-11): the duplicate review over several PDFs (MedAnki's
 * `find_duplicates_multi`) and the topic labels with their counts. Card ids are unique within one PDF only, so every
 * draft here is named by a `ref` — "jobId|cardId" — and the comparison runs on copies that carry it.
 */

import type { CardDraft, CardPageResult, CourseDraft, CourseDuplicateGroup, CourseGroupCard, CourseTag, DuplicateGroup } from "./contracts/create-cards.ts";

/** One PDF of a subject with its pages' drafts. */
export interface JobDrafts {
	id: string;
	name: string;
	pages: readonly CardPageResult[];
}

export const draftRef = (jobId: string, cardId: string): string => `${jobId}|${cardId}`;

export function splitRef(ref: string): { jobId: string; cardId: string } | null {
	const at = ref.indexOf("|");
	return at > 0 && at < ref.length - 1 ? { jobId: ref.slice(0, at), cardId: ref.slice(at + 1) } : null;
}

/** Page numbers of the copies are shifted by PDF, so "the same page" never holds across two PDFs. */
const PAGE_SPACE = 100_000;

export interface QualifiedDrafts {
	/** Copies of the drafts for the comparison (`id` is the ref, `page` shifted by PDF), in PDF order. */
	pages: { cards: CardDraft[] }[];
	/** The draft and its PDF, by ref. */
	origin: Map<string, CourseDraft>;
}

export function qualifyDrafts(jobs: readonly JobDrafts[]): QualifiedDrafts {
	const origin = new Map<string, CourseDraft>();
	const pages = jobs.flatMap((job, order) =>
		job.pages.map((page) => ({
			cards: page.cards.map((card) => {
				const ref = draftRef(job.id, card.id);
				origin.set(ref, { jobId: job.id, jobName: job.name, card });
				return { ...card, id: ref, page: order * PAGE_SPACE + card.page } as CardDraft;
			}),
		})),
	);
	return { pages, origin };
}

/** A group of qualified copies → the group with the real drafts and their PDFs. */
export function courseGroup(group: DuplicateGroup, origin: ReadonlyMap<string, CourseDraft>): CourseDuplicateGroup {
	const cards = group.cards.flatMap((copy): CourseGroupCard[] => {
		const found = origin.get(copy.id);
		return found ? [{ ref: copy.id, ...found }] : [];
	});
	return { id: group.id, kind: group.kind, reason: group.reason, score: group.score, keep: group.keep, cards, ...(group.semantic ? { semantic: true as const } : {}) };
}

/** The topic labels on the drafts that are not thrown away: how many are selected for adoption, and how many there are. Most used first. */
export function courseTags(items: readonly CourseDraft[]): CourseTag[] {
	const tags = new Map<string, CourseTag>();
	for (const { card } of items) {
		if (card.deleted) continue;
		for (const tag of card.tags) {
			const entry = tags.get(tag) ?? { tag, selected: 0, total: 0 };
			entry.total++;
			if (card.include) entry.selected++;
			tags.set(tag, entry);
		}
	}
	return [...tags.values()].sort((a, b) => b.total - a.total || a.tag.toLowerCase().localeCompare(b.tag.toLowerCase()));
}
