/**
 * Subjects and topics in Create (src/server/create-courses.ts) with a SCRIPTED model and throw-away stores: the topic
 * list (by hand, from a file, matched, tidied up), the PDFs of a subject, the assignment of drafts to topics, and the
 * duplicate review across PDFs — never data/*, never the real Claude CLI.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { ClaudeAskError, type AskClaude, type AskClaudeRequest } from "../src/agent/claude-ask.ts";
import { ASSIGN_SYSTEM, CONSOLIDATE_SYSTEM, MATCH_SYSTEM, TOPICS_SYSTEM } from "../src/agent/create/course-prompts.ts";
import { DEDUPE_SYSTEM } from "../src/agent/create/card-prompts.ts";
import { CreateInputError, type CardsJob } from "../src/core/contracts.ts";
import { type CardDraft, DEFAULT_CARD_SETTINGS, type FrontBackCard } from "../src/core/contracts/create-cards.ts";
import { patchCard } from "../src/server/create-cards-edit.ts";
import {
	assignStatus,
	type CourseDeps,
	courseSemanticStep,
	getCourseView,
	listCourseCards,
	listCourseTags,
	listCourseViews,
	proposeTopics,
	removeCourseDuplicates,
	reviewCourseDuplicates,
	setJobCourse,
	startAssign,
	topicsFromFile,
	undoAssign,
	updateCourse,
} from "../src/server/create-courses.ts";
import { createCreateStore } from "../src/store/create.ts";
import { createStudyStore } from "../src/store/study.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-courses-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const NOW = new Date(2026, 10, 5, 10, 0, 0);
const json = (value: unknown) => ({ text: JSON.stringify(value), costUsd: 0, durationMs: 1 });
const bytes = (text: string) => new TextEncoder().encode(text);

const card = (id: string, page: number, front: string, back: string, extra: Partial<FrontBackCard> = {}): CardDraft =>
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

let counter = 0;

function setup(ask: AskClaude = async () => json({}), uploadedPdfText: CourseDeps["uploadedPdfText"] = async () => "") {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const create = createCreateStore(path.join(dir, "create"));
	const study = createStudyStore({ courses: path.join(dir, "courses.jsonl"), cards: path.join(dir, "cards.jsonl"), reviews: path.join(dir, "reviews.jsonl") });
	study.upsertCourse({ id: "cardio", name: "Cardiology", bufferDays: 5, createdAt: NOW.toISOString() });
	study.upsertCourse({ id: "renal", name: "Renal", bufferDays: 5, createdAt: NOW.toISOString() });
	const asked: AskClaudeRequest[] = [];
	const deps: CourseDeps = {
		create,
		library: {} as CourseDeps["library"],
		study,
		ask: async (req) => {
			asked.push(req);
			return ask(req);
		},
		renderPage: async () => new Uint8Array(),
		pageLines: async () => [],
		documentText: async () => "",
		addPdf: async () => {
			throw new Error("not used");
		},
		now: () => NOW,
		retryDelayMs: 0,
		uploadedPdfText,
	};

	/** A finished cards job with the given drafts by page. */
	function addJob(name: string, courseId: string | undefined, pages: Record<number, CardDraft[]>, focus: string[] = [], pageTopics: Record<number, string> = {}): string {
		const id = `crt_test_${++counter}`;
		const job: CardsJob = {
			v: 1,
			id,
			kind: "cards",
			name,
			lectureId: "lec",
			nPages: 9,
			settings: { ...DEFAULT_CARD_SETTINGS, focusTopics: focus, focusStrict: false },
			...(courseId ? { courseId } : {}),
			state: "done",
			createdAt: new Date(NOW.getTime() + counter * 1000).toISOString(),
			pages: Object.fromEntries(Object.entries(pages).map(([n, cards]) => [n, { status: "done", count: cards.length, adopted: 0 }])),
		};
		create.createJob(job);
		for (const [n, cards] of Object.entries(pages)) {
			create.writeCardPage(id, { page: Number(n), pageType: "text", skip: false, skipReason: "", topic: pageTopics[Number(n)] ?? "", status: "done", cards, dropped: [] });
		}
		return id;
	}
	const cardsOf = (id: string, page: number) => create.readCardPage(id, page)!.cards;
	return { deps, create, study, asked, addJob, cardsOf };
}

describe("subjects as the Create area sees them", () => {
	it("lists the subjects with their topics, PDFs and drafts", () => {
		const { deps, study, addJob } = setup();
		study.upsertCourse({ id: "cardio", name: "Cardiology", bufferDays: 5, createdAt: NOW.toISOString(), topics: ["Heart failure"], strictTopics: true, deadline: "2026-12-01" });
		addJob("Lecture 1", "cardio", { 1: [card("p001-c01", 1, "a", "b"), card("p001-c02", 1, "c", "d")] });
		addJob("Lecture 2", "cardio", { 1: [card("p001-c01", 1, "e", "f")] });
		addJob("Other", undefined, { 1: [card("p001-c01", 1, "g", "h")] });
		const views = listCourseViews(deps);
		assert.deepEqual(views.find((v) => v.id === "cardio"), { id: "cardio", name: "Cardiology", topics: ["Heart failure"], strict: true, deadline: "2026-12-01", jobs: 2, drafts: 3 });
		assert.deepEqual(views.find((v) => v.id === "renal"), { id: "renal", name: "Renal", topics: [], strict: false, jobs: 0, drafts: 0 });
		assert.throws(() => getCourseView("nope", deps), (e) => e instanceof CreateInputError && e.status === 404);
	});

	it("stores topics and the 'only these' switch on the course; the switch needs topics", () => {
		const { deps, study } = setup();
		const view = updateCourse("cardio", { topics: " Heart failure ; valves,\nheart failure", strict: true }, deps);
		assert.deepEqual([view.topics, view.strict], [["Heart failure", "valves"], true]);
		assert.deepEqual(study.readCourses().find((c) => c.id === "cardio")?.topics, ["Heart failure", "valves"]);
		assert.equal(updateCourse("cardio", { topics: [] }, deps).strict, false);
		assert.equal(updateCourse("cardio", { strict: true }, deps).strict, false); // nothing to be strict about
	});

	it("renames a subject, not onto another one's name", () => {
		const { deps } = setup();
		assert.equal(updateCourse("cardio", { name: "  Cardiology  II " }, deps).name, "Cardiology II");
		assert.throws(() => updateCourse("cardio", { name: "renal" }, deps), (e) => e instanceof CreateInputError && e.status === 400);
		assert.throws(() => updateCourse("cardio", { name: " " }, deps), (e) => e instanceof CreateInputError && e.status === 400);
	});

	it("new topics become the focus of the PDFs that still had the old list — not of those with a focus of their own", () => {
		const { deps, create, addJob } = setup();
		updateCourse("cardio", { topics: ["Valves"] }, deps);
		const same = addJob("Same", "cardio", { 1: [] }, ["Valves"]);
		const own = addJob("Own", "cardio", { 1: [] }, ["Rhythm"]);
		const elsewhere = addJob("Elsewhere", "renal", { 1: [] }, ["Valves"]);
		updateCourse("cardio", { topics: ["Valves", "Heart failure"], strict: true }, deps);
		const focus = (id: string) => (create.get(id) as CardsJob).settings;
		assert.deepEqual([focus(same).focusTopics, focus(same).focusStrict], [["Valves", "Heart failure"], true]);
		assert.deepEqual(focus(own).focusTopics, ["Rhythm"]);
		assert.deepEqual(focus(elsewhere).focusTopics, ["Valves"]);
	});

	it("puts a PDF into a subject and out again", () => {
		const { deps, create, addJob } = setup();
		updateCourse("renal", { topics: ["Nephron"], strict: true }, deps);
		const free = addJob("Free", undefined, { 1: [] });
		const own = addJob("Own", undefined, { 1: [] }, ["Rhythm"]);
		(create.get(free) as CardsJob).retentionHint === undefined; // not set yet
		create.update(free, (j) => ((j as CardsJob).retentionHint = "old note"));

		const moved = setJobCourse(free, "renal", deps);
		assert.equal(moved.courseId, "renal");
		const job = create.get(free) as CardsJob;
		assert.deepEqual([job.settings.focusTopics, job.settings.focusStrict, job.retentionHint], [["Nephron"], true, undefined]);

		setJobCourse(own, "renal", deps);
		assert.deepEqual((create.get(own) as CardsJob).settings.focusTopics, ["Rhythm"]); // its own focus stays

		assert.equal(setJobCourse(free, null, deps).courseId, undefined);
		assert.throws(() => setJobCourse(free, "nope", deps), (e) => e instanceof CreateInputError && e.status === 404);
		assert.throws(() => setJobCourse("nope", "renal", deps), (e) => e instanceof CreateInputError && e.status === 404);
	});
});

describe("a topic list from a file", () => {
	it("a text file sets the topics of a subject that has none", async () => {
		const { deps, asked } = setup();
		const out = await topicsFromFile("cardio", { name: "Topics.TXT", data: bytes("- Heart failure\n2. Valves\nx\n") }, {}, deps);
		assert.deepEqual([out.source, out.found, out.matched, out.added], ["txt", 2, 0, ["Heart failure", "Valves"]]);
		assert.deepEqual(out.course.topics, ["Heart failure", "Valves"]);
		assert.equal(asked.length, 0, "a text file needs no model");
	});

	it("with topics set, Claude matches the entries and only really new ones are added", async () => {
		const { deps, asked, study } = setup(async (req) => {
			assert.equal(req.system, MATCH_SYSTEM);
			assert.equal(req.model, "haiku");
			return json({ matches: [{ new: 1, existing: 2 }, { new: 2, existing: 0 }] });
		});
		updateCourse("cardio", { topics: ["Heart failure", "Valves"] }, deps);
		const out = await topicsFromFile("cardio", { name: "t.md", data: bytes("Mitral stenosis\nPericarditis") }, {}, deps);
		assert.deepEqual([out.matched, out.added], [1, ["Pericarditis"]]);
		assert.deepEqual(study.readCourses().find((c) => c.id === "cardio")?.topics, ["Heart failure", "Valves", "Pericarditis"]);
		assert.match(asked[0]!.prompt, /Festgelegte Themen:\n1\. Heart failure\n2\. Valves/);
	});

	it("a PDF's text goes to Claude, which names the topics", async () => {
		const { deps, asked } = setup(
			async (req) => {
				assert.equal(req.system, TOPICS_SYSTEM);
				return json({ topics: ["Heart failure", " valves ", ""] });
			},
			async (data, maxChars) => {
				assert.equal(new TextDecoder().decode(data), "%PDF fake");
				assert.equal(maxChars, 15000);
				return "Goals: heart failure, valves";
			},
		);
		const out = await topicsFromFile("cardio", { name: "goals.pdf", data: bytes("%PDF fake") }, {}, deps);
		assert.deepEqual([out.source, out.course.topics], ["pdf", ["Heart failure", "valves"]]);
		assert.match(asked[0]!.prompt, /Fach: Cardiology\n\nAuszug aus der Datei:\nGoals: heart failure, valves/);
	});

	it("refuses what it cannot use, and tells a lost sign-in from a failed call", async () => {
		const { deps } = setup();
		const refused = (status: number) => (e: unknown) => e instanceof CreateInputError && e.status === status;
		await assert.rejects(topicsFromFile("cardio", { name: "t.docx", data: bytes("x") }, {}, deps), refused(400));
		await assert.rejects(topicsFromFile("cardio", { name: "t.txt", data: bytes("a\n\nb") }, {}, deps), refused(400)); // no topics in it
		await assert.rejects(topicsFromFile("nope", { name: "t.txt", data: bytes("Heart failure") }, {}, deps), refused(404));
		await assert.rejects(topicsFromFile("cardio", { name: "t.pdf", data: bytes("x") }, {}, deps), refused(400)); // no readable text

		const unreadable = setup(async () => json({}), async () => {
			throw new Error("password");
		});
		await assert.rejects(topicsFromFile("cardio", { name: "t.pdf", data: bytes("x") }, {}, unreadable.deps), refused(400));

		const signedOut = setup(
			async () => {
				throw new ClaudeAskError("Please sign in", "auth");
			},
			async () => "text",
		);
		await assert.rejects(topicsFromFile("cardio", { name: "t.pdf", data: bytes("x") }, {}, signedOut.deps), refused(409));

		const broken = setup(
			async () => {
				throw new ClaudeAskError("boom", "other");
			},
			async () => "text",
		);
		await assert.rejects(topicsFromFile("cardio", { name: "t.pdf", data: bytes("x") }, {}, broken.deps), refused(502));
		assert.deepEqual(getCourseView("cardio", broken.deps).topics, []);
	});
});

describe("tidying the topics up", () => {
	it("sends the topics, the page titles and the labels, and returns a proposal that saves nothing", async () => {
		const { deps, asked, addJob, study } = setup(async (req) => {
			assert.equal(req.system, CONSOLIDATE_SYSTEM);
			return json({ topics: [{ name: "Heart failure", source: "liste" }, { name: "heart failure", source: "vorlesung" }, { name: "Pericardium", source: "vorlesung" }] });
		});
		updateCourse("cardio", { topics: ["Heart failure - causes", "Heart failure - signs"] }, deps);
		addJob("Lecture 1", "cardio", { 3: [card("p003-c01", 3, "a", "b", { tags: ["Heart"] }), card("p003-c02", 3, "c", "d", { tags: ["Heart", "Valves"] }), card("p003-c03", 3, "e", "f", { tags: ["Gone"], deleted: true })] }, [], { 3: "Heart failure" });
		const proposal = await proposeTopics("cardio", {}, deps);
		assert.deepEqual(proposal.topics, [{ name: "Heart failure", source: "list" }, { name: "Pericardium", source: "lecture" }]);
		assert.deepEqual(proposal.current, ["Heart failure - causes", "Heart failure - signs"]);
		assert.match(asked[0]!.prompt, /- Lecture 1, S\. 3: Heart failure/);
		assert.match(asked[0]!.prompt, /Heart \(2\), Valves \(1\)/);
		assert.doesNotMatch(asked[0]!.prompt, /Gone/);
		assert.deepEqual(study.readCourses().find((c) => c.id === "cardio")?.topics, ["Heart failure - causes", "Heart failure - signs"]);
	});

	it("needs something to go on, and a usable answer", async () => {
		const { deps } = setup(async () => json({ topics: [] }));
		await assert.rejects(proposeTopics("renal", {}, deps), (e) => e instanceof CreateInputError && e.status === 400);
		updateCourse("renal", { topics: ["Nephron"] }, deps);
		await assert.rejects(proposeTopics("renal", {}, deps), (e) => e instanceof CreateInputError && e.status === 502);
	});
});

const settled = async (courseId: string) => {
	for (let i = 0; i < 200; i++) {
		if (assignStatus(courseId).state !== "running") return assignStatus(courseId);
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("the assignment did not finish");
};

/** A model that files cards by a word in their text. */
const byWord: AskClaude = async (req) => {
	assert.equal(req.system, ASSIGN_SYSTEM);
	const assignments = [...req.prompt.matchAll(/^(\S+): (.*)$/gm)].map((m) => ({ id: m[1]!, topic: /valve/i.test(m[2]!) ? 2 : /failure/i.test(m[2]!) ? 1 : 0 }));
	return json({ assignments });
};

describe("giving the drafts the topics of the subject", () => {
	function withDrafts(ask: AskClaude = byWord) {
		const s = setup(ask);
		updateCourse("cardio", { topics: ["Heart failure", "Valves"] }, s.deps);
		const one = s.addJob("Lecture 1", "cardio", { 1: [card("p001-c01", 1, "Signs of heart failure?", "Edema", { tags: ["Heart"] }), card("p001-c02", 1, "Mitral valve location?", "Left", { tags: ["Valves"] })] });
		const two = s.addJob("Lecture 2", "cardio", { 4: [card("p004-c01", 4, "Normal heart rate?", "60-100", { tags: ["Rhythm"] }), card("p004-c02", 4, "Gone?", "yes", { deleted: true, tags: ["x"] })] });
		return { ...s, one, two };
	}

	it("labels every draft of every PDF, keeping the old labels for an undo", async () => {
		const { deps, one, two, cardsOf } = withDrafts();
		assert.equal(startAssign("cardio", deps), true);
		const status = await settled("cardio");
		assert.deepEqual([status.state, status.total, status.done, status.result], ["done", 3, 3, { assigned: 3, other: 1, skipped: 0 }]);
		assert.deepEqual(cardsOf(one, 1).map((c) => c.tags), [["Heart failure"], ["Valves"]]);
		assert.deepEqual(cardsOf(two, 4).map((c) => c.tags), [["Other"], ["x"]]);
		assert.deepEqual(cardsOf(one, 1).map((c) => c.prevTags), [["Heart"], ["Valves"]]);
		assert.equal(cardsOf(two, 4)[1]!.prevTags, undefined, "a thrown-away draft is left alone");
		assert.deepEqual(listCourseTags("cardio", deps), [
			{ tag: "Heart failure", selected: 1, total: 1 },
			{ tag: "Other", selected: 1, total: 1 },
			{ tag: "Valves", selected: 1, total: 1 },
		]);

		// asking again keeps the labels from BEFORE the first assignment
		startAssign("cardio", deps);
		await settled("cardio");
		assert.deepEqual(cardsOf(one, 1).map((c) => c.prevTags), [["Heart"], ["Valves"]]);

		assert.equal(undoAssign("cardio", deps), 3);
		assert.deepEqual(cardsOf(one, 1).map((c) => c.tags), [["Heart"], ["Valves"]]);
		assert.deepEqual(cardsOf(two, 4).map((c) => c.tags), [["Rhythm"], ["x"]]);
		assert.equal(cardsOf(one, 1)[0]!.prevTags, undefined);
		assert.equal(assignStatus("cardio").state, "none");
	});

	it("goes through the drafts in batches of 60", async () => {
		const s = setup(byWord);
		updateCourse("cardio", { topics: ["Heart failure"] }, s.deps);
		const many = Array.from({ length: 130 }, (_, i) => card(`p001-c${String(i + 1).padStart(2, "0")}`, 1, `Heart failure fact ${i}`, "x"));
		const id = s.addJob("Big", "cardio", { 1: many });
		startAssign("cardio", s.deps);
		const status = await settled("cardio");
		assert.deepEqual([status.state, status.total, s.asked.length], ["done", 130, 3]);
		assert.ok(s.cardsOf(id, 1).every((c) => c.tags[0] === "Heart failure"));
		assert.equal(s.asked[0]!.model, "haiku");
	});

	it("leaves study cards and pages that are being worked on alone", async () => {
		const { deps, create, one, two, cardsOf } = withDrafts();
		const adopted = cardsOf(one, 1);
		adopted[0]!.adopted = { courseId: "cardio", cardId: "crt_x", at: NOW.toISOString() };
		create.writeCardPage(one, { page: 1, pageType: "text", skip: false, skipReason: "", topic: "", status: "done", cards: adopted, dropped: [] });
		create.update(two, (j) => (j.pages["4"]!.status = "running"));
		startAssign("cardio", deps);
		const status = await settled("cardio");
		assert.deepEqual(status.result, { assigned: 1, other: 0, skipped: 2 });
		assert.deepEqual(cardsOf(one, 1).map((c) => c.tags), [["Heart"], ["Valves"]].map((t, i) => (i === 1 ? ["Valves"] : t)));
		assert.deepEqual(cardsOf(two, 4)[0]!.tags, ["Rhythm"]);
		assert.equal(undoAssign("cardio", deps), 1);
	});

	it("needs topics, runs once at a time, and reports a failed call", async () => {
		const { deps } = setup();
		assert.throws(() => startAssign("renal", deps), (e) => e instanceof CreateInputError && e.status === 400);

		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const slow = withDrafts(async (req) => {
			await gate;
			return byWord(req);
		});
		assert.equal(startAssign("cardio", slow.deps), true);
		assert.equal(startAssign("cardio", slow.deps), false);
		assert.throws(() => undoAssign("cardio", slow.deps), (e) => e instanceof CreateInputError && e.status === 409);
		release();
		await settled("cardio");

		const failing = withDrafts(async () => {
			throw new ClaudeAskError("Please sign in", "auth");
		});
		startAssign("cardio", failing.deps);
		const status = await settled("cardio");
		assert.equal(status.state, "error");
		assert.match(status.error, /sign in/);
		assert.deepEqual(failing.cardsOf(failing.one, 1).map((c) => c.tags), [["Heart"], ["Valves"]], "nothing changed");
	});

	it("lists the drafts of a subject, by label", () => {
		const { deps, one, two, cardsOf } = withDrafts();
		cardsOf(one, 1);
		const all = listCourseCards("cardio", undefined, deps);
		assert.deepEqual(all.map((d) => [d.jobName, d.card.id]), [["Lecture 1", "p001-c01"], ["Lecture 1", "p001-c02"], ["Lecture 2", "p004-c01"]]);
		assert.deepEqual(listCourseCards("cardio", "Valves", deps).map((d) => d.jobId), [one]);
		assert.deepEqual(listCourseCards("cardio", "Rhythm", deps).map((d) => d.jobId), [two]);
		assert.deepEqual(listCourseCards("renal", undefined, deps), []);
	});
});

describe("duplicates across the PDFs of a subject", () => {
	const q = "What is the most common cause of heart failure in the western world?";

	function twoLectures(ask?: AskClaude) {
		const s = setup(ask);
		const overview = s.addJob("Overview", "cardio", { 3: [card("p003-c01", 3, q, "Coronary artery disease")] });
		const detail = s.addJob("Detail", "cardio", { 3: [card("p003-c01", 3, q, "Coronary artery disease"), card("p003-c02", 3, "Which drug class lowers afterload?", "ACE inhibitors")] });
		return { ...s, overview, detail };
	}

	it("finds the same card in two PDFs although both call it p003-c01", () => {
		const { deps, overview, detail } = twoLectures();
		const review = reviewCourseDuplicates("cardio", 0.8, deps);
		assert.equal(review.groups.length, 1);
		const group = review.groups[0]!;
		assert.deepEqual(group.cards.map((c) => c.jobId).sort(), [detail, overview].sort());
		assert.deepEqual(group.cards.map((c) => c.card.id), ["p003-c01", "p003-c01"]);
		assert.equal(group.cards[0]!.ref, group.keep);
		assert.deepEqual(group.cards.map((c) => c.jobName).sort(), ["Detail", "Overview"]);
	});

	it("takes the other copy away (soft, with a note) and keeps the one chosen", () => {
		const { deps, overview, detail, cardsOf } = twoLectures();
		const group = reviewCourseDuplicates("cardio", 0.8, deps).groups[0]!;
		const [keep, drop] = group.cards.map((c) => c.ref);
		assert.equal(removeCourseDuplicates("cardio", [{ keep: drop!, remove: [keep!] }], deps), 1);
		const [dropJob, dropCard] = drop!.split("|");
		const [keepJob, keepCard] = keep!.split("|");
		assert.equal(cardsOf(keepJob!, 3).find((c) => c.id === keepCard)!.deleted, true);
		assert.match(cardsOf(keepJob!, 3).find((c) => c.id === keepCard)!.note ?? "", /^Duplicate of /);
		assert.equal(cardsOf(dropJob!, 3).find((c) => c.id === dropCard)!.deleted, false);
		assert.equal(reviewCourseDuplicates("cardio", 0.8, deps).groups.length, 0);
		assert.equal(reviewCourseDuplicates("cardio", 0.8, deps).autoRemoved, 1);
		void overview;
		void detail;
	});

	it("never removes a card some group keeps, a study card, or a card of another subject; refuses busy pages as a whole", () => {
		const { deps, create, overview, detail, cardsOf, addJob } = twoLectures();
		const stranger = addJob("Renal", "renal", { 1: [card("p001-c01", 1, q, "Coronary artery disease")] });
		const a = `${overview}|p003-c01`;
		const b = `${detail}|p003-c01`;
		assert.equal(removeCourseDuplicates("cardio", [{ keep: a, remove: [b] }, { keep: b, remove: [a] }], deps), 0);
		assert.equal(removeCourseDuplicates("cardio", [{ keep: a, remove: [`${stranger}|p001-c01`, "nonsense", `${detail}|p003-c99`] }], deps), 0);
		assert.equal(cardsOf(stranger, 1)[0]!.deleted, false);

		const adopted = cardsOf(detail, 3);
		adopted[0]!.adopted = { courseId: "cardio", cardId: "crt_x", at: NOW.toISOString() };
		create.writeCardPage(detail, { page: 3, pageType: "text", skip: false, skipReason: "", topic: "", status: "done", cards: adopted, dropped: [] });
		assert.equal(removeCourseDuplicates("cardio", [{ keep: a, remove: [b] }], deps), 0);

		create.update(overview, (j) => (j.pages["3"]!.status = "running"));
		assert.throws(() => removeCourseDuplicates("cardio", [{ keep: b, remove: [a, `${detail}|p003-c02`] }], deps), (e) => e instanceof CreateInputError && e.status === 409);
		assert.equal(cardsOf(detail, 3)[1]!.deleted, false, "nothing was changed");
	});

	it("Claude's check works across PDFs, remembers what it asked, and gives groups with their PDFs", async () => {
		const asks: AskClaudeRequest[] = [];
		const { deps, create, overview, detail } = twoLectures(async (req) => {
			assert.equal(req.system, DEDUPE_SYSTEM);
			asks.push(req);
			const pairs = [...req.prompt.matchAll(/^- (\S+) <-> (\S+)$/gm)].map((m) => [m[1]!, m[2]!]);
			return json({ groups: pairs.slice(0, 1) });
		});
		// another wording of the same fact, in the second lecture
		const page = create.readCardPage(detail, 3)!;
		page.cards.push(card("p003-c03", 3, "Which condition most often causes heart failure in western countries?", "Coronary artery disease"));
		create.writeCardPage(detail, page);

		const step = await courseSemanticStep("cardio", { threshold: 0.95 }, deps);
		assert.equal(step.error, null);
		assert.equal(asks.length, 1);
		assert.ok(asks[0]!.prompt.includes(`${overview}|p003-c01`) || asks[0]!.prompt.includes(`${detail}|p003-c01`), "cards are named by ref");
		assert.equal(step.groups.length, 1);
		assert.equal(step.groups[0]!.semantic, true);
		assert.ok(step.groups[0]!.cards.every((c) => c.jobName === "Overview" || c.jobName === "Detail"));

		const review = reviewCourseDuplicates("cardio", 0.95, deps);
		assert.equal(review.semantic.length, 1);
		assert.deepEqual(deps.create.readDedupeCache(`course_cardio`).checked.length >= 2, true);

		const again = await courseSemanticStep("cardio", { threshold: 0.95 }, deps);
		assert.deepEqual([again.checkedNow, again.done, asks.length], [0, true, 1]);

		// a draft thrown away drops out of Claude's group
		const members = step.groups[0]!.cards;
		const gone = members.find((c) => c.jobId === detail)!;
		patchCard(detail, gone.card.id, { deleted: true }, deps);
		assert.equal(reviewCourseDuplicates("cardio", 0.95, deps).semantic.length, 0);
	});

	it("reports a failed call and keeps the progress", async () => {
		const { deps, create, detail } = twoLectures(async () => {
			throw new ClaudeAskError("network down", "other");
		});
		const page = create.readCardPage(detail, 3)!;
		page.cards.push(card("p003-c03", 3, "Which condition most often causes heart failure in western countries?", "Coronary artery disease"));
		create.writeCardPage(detail, page);
		const step = await courseSemanticStep("cardio", { threshold: 0.95 }, deps);
		assert.match(step.error ?? "", /network down/);
		assert.equal(step.done, false);
		assert.deepEqual(deps.create.readDedupeCache("course_cardio"), { checked: [], groups: [] });
	});

	it("the subject's folder for Claude and its progress is not a job", () => {
		const { deps } = twoLectures();
		reviewCourseDuplicates("cardio", 0.8, deps);
		deps.create.workDir("course_cardio");
		deps.create.writeDedupeCache("course_cardio", { checked: ["a"], groups: [] });
		assert.deepEqual(deps.create.list().map((j) => j.name).sort(), ["Detail", "Overview"]);
	});
});
