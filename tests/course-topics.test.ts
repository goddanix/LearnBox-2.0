/**
 * The subject / topic rules are MedAnki's: tests/fixtures/medanki-course-prompts.json holds what MedAnki's own Python
 * code produces (regenerate with tests/fixtures/gen-medanki-course-prompts.py) — the verbatim German prompts and the
 * small pure functions around them. Below that: the parts Learnbox added (the drafts of a subject across PDFs, the
 * retention from the review ledger).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	ASSIGN_SYSTEM,
	assignPrompt,
	CONSOLIDATE_SYSTEM,
	consolidatePrompt,
	MATCH_SYSTEM,
	matchPrompt,
	TOPICS_SYSTEM,
	topicsPrompt,
} from "../src/agent/create/course-prompts.ts";
import { retentionHint } from "../src/agent/create/card-prompts.ts";
import {
	ASSIGN_BATCH,
	assignCardText,
	cleanProposal,
	courseGroup,
	courseRetention,
	courseTags,
	draftRef,
	MAX_NEW_PER_UPLOAD,
	mergeTopics,
	MIN_RETENTION_REVIEWS,
	OTHER_TOPIC,
	parseAssignments,
	parseMatches,
	qualifyDrafts,
	splitRef,
	topicsFromText,
} from "../src/core/index.ts";
import { findGroups } from "../src/core/card-dedupe.ts";
import type { CardDraft, CardPageResult, StudyReview } from "../src/core/index.ts";

const golden = JSON.parse(readFileSync(new URL("./fixtures/medanki-course-prompts.json", import.meta.url), "utf-8"));

describe("subject prompts match MedAnki's", () => {
	it("topic list from a file", () => {
		assert.equal(TOPICS_SYSTEM, golden.topicsSystem);
		assert.equal(topicsPrompt(golden.topicsPrompt.course, golden.topicsPrompt.text), golden.topicsPrompt.out);
	});

	it("tidy-up into main topics", () => {
		assert.equal(CONSOLIDATE_SYSTEM, golden.consolidateSystem);
		const g = golden.consolidatePrompt;
		assert.equal(
			consolidatePrompt(
				g.course,
				g.list,
				g.pages,
				g.labels.map(([t, n]: [string, number]) => [t, n] as const),
			),
			g.out,
		);
		assert.equal(consolidatePrompt(g.course, [], [], []), g.empty);
	});

	it("match of a new list against the topics set", () => {
		assert.equal(MATCH_SYSTEM, golden.matchSystem);
		assert.equal(MAX_NEW_PER_UPLOAD, 5);
		assert.equal(matchPrompt(golden.matchPrompt.existing, golden.matchPrompt.new), golden.matchPrompt.out);
	});

	it("assignment of cards to topics", () => {
		assert.equal(ASSIGN_SYSTEM, golden.assignSystem);
		assert.equal(ASSIGN_BATCH, golden.assignBatch);
		assert.equal(OTHER_TOPIC, golden.assignOther);
		const g = golden.assignPrompt;
		const texts = golden.cardText.map((c: { out: string }) => c.out);
		assert.equal(
			assignPrompt(
				g.topics,
				g.keys.map((k: string, i: number) => [k, texts[i]] as const),
			),
			g.out,
		);
	});
});

describe("subject rules match MedAnki's", () => {
	it("topics from text", () => {
		assert.deepEqual(topicsFromText(golden.topicsFromText.input), golden.topicsFromText.output);
		assert.deepEqual(topicsFromText(""), []);
	});

	for (const [n, c] of (golden.parseMatches as { raw: unknown; nExisting: number; nNew: number; out: Record<string, number> }[]).entries()) {
		it(`parse matches #${n + 1}`, () => {
			assert.deepEqual(Object.fromEntries([...parseMatches(c.raw, c.nExisting, c.nNew)].map(([k, v]) => [String(k), v])), c.out);
		});
	}

	for (const [n, c] of (golden.mergeTopics as { existing: string[]; extracted: string[]; matches: Record<string, number>; topics: string[]; report: { zugeordnet: number; neu: string[] } }[]).entries()) {
		it(`merge topics #${n + 1}`, () => {
			const merged = mergeTopics(c.existing, c.extracted, new Map(Object.entries(c.matches).map(([k, v]) => [Number(k), v])));
			assert.deepEqual(merged.topics, c.topics);
			assert.equal(merged.matched, c.report.zugeordnet);
			assert.deepEqual(merged.added, c.report.neu);
		});
	}

	for (const [n, c] of (golden.cleanProposal as { raw: unknown; out: { name: string; source: string }[] }[]).entries()) {
		it(`clean proposal #${n + 1}`, () => {
			assert.deepEqual(
				cleanProposal(c.raw),
				c.out.map((t) => ({ name: t.name, source: t.source === "liste" ? "list" : "lecture" })),
			);
		});
	}

	// The fixture's cards are MedAnki's dicts; the drafts below carry just what the text of a card needs.
	const draft = (c: { type: string; front?: string; back?: string; text?: string; header?: string; label?: string }): CardDraft => ({ ...c, id: "x", page: 1, tags: [] }) as unknown as CardDraft;

	for (const c of golden.cardText as { card: Parameters<typeof draft>[0]; out: string }[]) {
		it(`card text of a ${c.card.type} card`, () => {
			assert.equal(assignCardText(draft(c.card)), c.out);
		});
	}

	for (const [n, c] of (golden.assignParse as { raw: unknown; out: Record<string, string> }[]).entries()) {
		it(`parse assignments #${n + 1}`, () => {
			const keys = new Set<string>(golden.assignPrompt.keys);
			assert.deepEqual(Object.fromEntries(parseAssignments(c.raw, ["Heart failure", "Valves"], keys)), c.out);
		});
	}
});

// ─── what Learnbox added ─────────────────────────────────────────────────────

const basic = (id: string, page: number, front: string, back: string, extra: Partial<CardDraft> = {}): CardDraft =>
	({
		type: "basic",
		id,
		page,
		tier: 2,
		whyType: "",
		extra: "",
		evidence: "",
		tags: [],
		warnings: [],
		deleted: false,
		include: true,
		manual: false,
		sourceIds: [],
		sourceBbox: null,
		image: null,
		front,
		back,
		...extra,
	}) as CardDraft;

const resultOf = (page: number, cards: CardDraft[]): CardPageResult => ({ page, pageType: "text", skip: false, skipReason: "", topic: "", status: "done", cards, dropped: [] });

describe("the drafts of a subject across PDFs", () => {
	const q = "What is the most common cause of heart failure in the western world?";
	const jobs = [
		{ id: "j1", name: "Overview", pages: [resultOf(3, [basic("p003-c01", 3, q, "Coronary artery disease")])] },
		{ id: "j2", name: "Detail", pages: [resultOf(3, [basic("p003-c01", 3, q, "Coronary artery disease")])] },
	];

	it("refs name a draft by PDF and id", () => {
		assert.equal(draftRef("j1", "p003-c01"), "j1|p003-c01");
		assert.deepEqual(splitRef("j1|p003-c01"), { jobId: "j1", cardId: "p003-c01" });
		assert.equal(splitRef("nonsense"), null);
		assert.equal(splitRef("|x"), null);
	});

	it("the same id in two PDFs stays two cards and is found as one group", () => {
		const { pages, origin } = qualifyDrafts(jobs);
		assert.equal(origin.size, 2);
		const groups = findGroups(pages, 0.8).map((g) => courseGroup(g, origin));
		assert.equal(groups.length, 1);
		assert.deepEqual(groups[0]!.cards.map((c) => c.jobName).sort(), ["Detail", "Overview"]);
		assert.equal(groups[0]!.cards[0]!.card.id, "p003-c01"); // the real draft, not the copy
		assert.equal(groups[0]!.keep, groups[0]!.cards[0]!.ref);
	});

	it("a mask at the same page number of two PDFs is not 'the same mask'", () => {
		const occ = (id: string): CardDraft =>
			({
				...basic(id, 3, "", ""),
				type: "image_occlusion",
				header: "Heart",
				mode: "one",
				figureBbox: [0.1, 0.1, 0.9, 0.9],
				label: "Left atrium",
				hint: "",
				boxes: [[0.2, 0.2, 0.3, 0.3]],
				allBoxes: [[0.2, 0.2, 0.3, 0.3]],
			}) as unknown as CardDraft;
		const other = qualifyDrafts([
			{ id: "j1", name: "A", pages: [resultOf(3, [occ("p003-c01")])] },
			{ id: "j2", name: "B", pages: [resultOf(3, [occ("p003-c01")])] },
		]);
		assert.equal(findGroups(other.pages, 0.8).length, 0); // different figures (no hash): not the same card
	});

	it("topic labels with counts, most used first, thrown-away drafts left out", () => {
		const items = [
			{ jobId: "j1", jobName: "A", card: basic("a", 1, "q1", "a1", { tags: ["Valves"], include: true }) },
			{ jobId: "j1", jobName: "A", card: basic("b", 1, "q2", "a2", { tags: ["Valves"], include: false }) },
			{ jobId: "j2", jobName: "B", card: basic("c", 1, "q3", "a3", { tags: ["Heart failure"] }) },
			{ jobId: "j2", jobName: "B", card: basic("d", 1, "q4", "a4", { tags: ["Heart failure"], deleted: true }) },
			{ jobId: "j2", jobName: "B", card: basic("e", 1, "q5", "a5", { tags: ["Valves"] }) },
		];
		assert.deepEqual(courseTags(items), [
			{ tag: "Valves", selected: 2, total: 3 },
			{ tag: "Heart failure", selected: 1, total: 1 },
		]);
	});
});

describe("retention from the review ledger", () => {
	const now = new Date("2026-11-05T10:00:00.000Z");
	const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
	const reviews = (n: number, againEvery: number, daysAgo = 3): StudyReview[] =>
		Array.from({ length: n }, (_, i) => ({ cardId: `c${i % 5}`, at: new Date(new Date(day(daysAgo)).getTime() + i * 1000).toISOString(), grade: i % againEvery === 0 ? 1 : 3 }) as StudyReview);
	const cards = new Set(["c0", "c1", "c2", "c3", "c4"]);

	it("share of answers that were not Again over the last weeks", () => {
		const r = courseRetention(reviews(100, 4), cards, now);
		assert.deepEqual(r, { reviews: 100, retention: 75 });
	});

	it("too few answers say nothing", () => {
		assert.equal(courseRetention(reviews(MIN_RETENTION_REVIEWS - 1, 4), cards, now), null);
	});

	it("answers older than the window, of other subjects and undone ones do not count", () => {
		const old = reviews(100, 4, 90);
		assert.equal(courseRetention(old, cards, now), null);
		assert.equal(courseRetention(reviews(100, 4), new Set(["other"]), now), null);
		const withUndo: StudyReview[] = [...reviews(60, 1000), { cardId: "c0", at: new Date(now.getTime() - 1000).toISOString(), grade: 3, undo: true }];
		assert.equal(courseRetention(withUndo, cards, now)?.reviews, 59);
	});

	it("the hint names the subject, the percentage and the weeks", () => {
		const hint = retentionHint("Kardiologie", 71.4, 60);
		assert.match(hint, /Fach „Kardiologie“/);
		assert.match(hint, /nur bei 71%/);
		assert.match(hint, /letzten 60 Tagen/);
		assert.ok(hint.startsWith("\n# Rückmeldung aus früherem Lernen\n"));
	});
});
