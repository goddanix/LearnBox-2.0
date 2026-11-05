/**
 * Cards from a lesson (Slice 9c): the pure rules (core/lesson-cards.ts) and the service
 * (server/create-lesson.ts) end to end with a SCRIPTED model — a throw-away create store, study store and chat
 * double; never data/*, never the real Claude CLI.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { ClaudeAskError, type AskClaude, type AskClaudeRequest } from "../src/agent/claude-ask.ts";
import { CardEditError } from "../src/core/card-edit.ts";
import { CreateInputError, type ChatRecord, type GraphNode, type LessonDraft, type StudyCard } from "../src/core/contracts.ts";
import {
	applyLessonEdit,
	cleanLessonSettings,
	existingCardTexts,
	graphCardCounts,
	lessonDrafts,
	lessonStatements,
	lessonStudyCards,
	nextDraftIndex,
	pickedStatements,
	validateLessonCard,
	withCardCounts,
	withoutCards,
} from "../src/core/lesson-cards.ts";
import type { ChatStore } from "../src/core/ports.ts";
import { stopCreateJob } from "../src/server/create.ts";
import {
	adoptLessonCards,
	createLessonJob,
	getLessonJob,
	lessonSource,
	patchLessonCard,
	setLessonInclude,
	startLessonJob,
	type LessonDeps,
} from "../src/server/create-lesson.ts";
import { createCreateStore } from "../src/store/create.ts";
import { createStudyStore } from "../src/store/study.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-lesson-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const NOW = new Date(2026, 10, 5, 10, 0, 0);

const node = (id: string, name: string, statement: string): GraphNode => ({ id, name, statement, aliases: [], createdAt: NOW.toISOString(), provenance: [] });
const PROPOSITIONS = [
	node("n_median", "Median nerve", "The median nerve passes through the carpal tunnel."),
	node("n_ulnar", "Ulnar nerve", "The ulnar nerve passes through Guyon's canal and supplies the hypothenar muscles."),
	node("n_radial", "Radial nerve", "The radial nerve wraps around the humerus in the radial groove."),
	node("n_other", "Femoral nerve", "The femoral nerve supplies the quadriceps."),
];
const NODE_SESSIONS = { n_median: ["chat_a"], n_ulnar: ["chat_a", "chat_b"], n_radial: ["chat_a"], n_other: ["chat_b"] };

describe("the pure rules", () => {
	it("cleans settings: defaults for rubbish, numbers clamped", () => {
		assert.deepEqual(cleanLessonSettings(undefined), { model: "sonnet", language: "en", maxPerStatement: 3, concurrency: 2 });
		const s = cleanLessonSettings({ model: "opus", language: "de", maxPerStatement: 9, concurrency: 0 });
		assert.deepEqual(s, { model: "opus", language: "de", maxPerStatement: 3, concurrency: 1 });
		assert.equal(cleanLessonSettings({ model: "bad model!", language: "xx" }).model, "sonnet");
		assert.equal(cleanLessonSettings({ language: "xx" }).language, "en");
	});

	it("offers the propositions a lesson touched, in graph order, and the ones a graph pick names", () => {
		const graph = { propositions: PROPOSITIONS, nodeSessions: NODE_SESSIONS };
		assert.deepEqual(lessonStatements(graph, "chat_a").map((s) => s.nodeId), ["n_median", "n_ulnar", "n_radial"]);
		assert.deepEqual(lessonStatements(graph, "chat_b").map((s) => s.nodeId), ["n_ulnar", "n_other"]);
		assert.deepEqual(lessonStatements(graph, "chat_none"), []);
		assert.deepEqual(pickedStatements(graph, ["n_other", "n_median", "n_gone"]).map((s) => s.nodeId), ["n_median", "n_other"]);
		assert.equal(lessonStatements(graph, "chat_a")[0]!.statement, "The median nerve passes through the carpal tunnel.");
	});

	it("counts the cards that already come from a statement (suspended ones do not count) and ticks the ones without", () => {
		const base = { courseId: "c", kind: "basic" as const, fields: {}, tags: [], core: true, createdAt: "" };
		const cards: StudyCard[] = [
			{ ...base, id: "1", origin: { kind: "graph", nodeId: "n_median" } },
			{ ...base, id: "2", origin: { kind: "graph", nodeId: "n_median", jobId: "j", draftId: "p001-c01" } },
			{ ...base, id: "3", origin: { kind: "graph", nodeId: "n_ulnar" }, suspended: true },
			{ ...base, id: "4", origin: { kind: "manual" } },
			{ ...base, id: "5", origin: { kind: "pdf", jobId: "j", page: 1 } },
		];
		assert.deepEqual([...graphCardCounts(cards)], [["n_median", 2]]);
		const options = withCardCounts(lessonStatements({ propositions: PROPOSITIONS, nodeSessions: NODE_SESSIONS }, "chat_a"), cards);
		assert.deepEqual(options.map((o) => o.cards), [2, 0, 0]);
		assert.deepEqual(withoutCards(options), ["n_ulnar", "n_radial"]);
	});

	it("reads what the model answered: usable cards only, at most `max`, no exact repeats", () => {
		const answer = {
			cards: [
				{ type: "basic", front: "Which nerve passes through the carpal tunnel?", back: "The median nerve.", extra: "" },
				{ type: "basic", front: "which nerve passes through the carpal tunnel?", back: "the median nerve." }, // same, other case
				{ type: "basic", front: "", back: "empty front" },
				{ type: "cloze", text: "no gap here" },
				{ type: "cloze", text: "The {{c1::median nerve}} passes through the carpal tunnel.", extra: "tunnel" },
				{ type: "basic_reversed", front: "x", back: "y" }, // a type the lesson does not know
				"not an object",
				{ type: "basic", front: "Q3", back: "A3" },
				{ type: "basic", front: "Q4", back: "A4" },
			],
		};
		const { cards, note } = lessonDrafts(answer, 3, 3);
		assert.equal(note, "");
		assert.deepEqual(cards.map((c) => c.id), ["p003-c01", "p003-c02", "p003-c03"]);
		assert.deepEqual(cards.map((c) => c.type), ["basic", "cloze", "basic"]);
		assert.ok(cards.every((c) => c.page === 3 && !c.deleted && c.include));
		assert.equal(cards[1]!.type === "cloze" && cards[1]!.extra, "tunnel");
		assert.equal(lessonDrafts(answer, 3, 1).cards.length, 1);
		assert.equal(lessonDrafts(answer, 3, 3, 4).cards[0]!.id, "p003-c04");
	});

	it("keeps the model's reason when it makes no card", () => {
		assert.deepEqual(lessonDrafts({ cards: [], note: "Too vague to ask." }, 1, 3), { cards: [], note: "Too vague to ask." });
		assert.deepEqual(lessonDrafts({ cards: [{ type: "basic", front: "", back: "" }], note: "ignored when…" }, 1, 3).cards, []);
		assert.deepEqual(lessonDrafts({}, 1, 3), { cards: [], note: "" });
		assert.equal(lessonDrafts({ cards: [], note: "x".repeat(900) }, 1, 3).note.length, 300);
		assert.equal(validateLessonCard({ type: "cloze", text: "broken {{c1::syntax" }), null);
		assert.equal(validateLessonCard(null), null);
	});

	it("numbers new drafts after the highest one, also after deletions", () => {
		assert.equal(nextDraftIndex([]), 1);
		assert.equal(nextDraftIndex([{ id: "p001-c01" }, { id: "p001-c04" }]), 5);
	});

	it("edits a draft whole or not at all", () => {
		const basic: LessonDraft = { id: "p001-c01", page: 1, type: "basic", front: "Q", back: "A", extra: "", deleted: false, include: true };
		applyLessonEdit(basic, { front: " New Q ", extra: "tip", include: false });
		assert.deepEqual([basic.front, basic.back, basic.extra, basic.include, basic.edited], ["New Q", "A", "tip", false, true]);
		assert.throws(() => applyLessonEdit(basic, { front: "fine", back: "" }), CardEditError);
		assert.equal(basic.front, "New Q"); // refused whole: nothing changed
		const cloze: LessonDraft = { id: "p001-c02", page: 1, type: "cloze", text: "A {{c1::b}}", extra: "", deleted: false, include: true };
		assert.throws(() => applyLessonEdit(cloze, { text: "no gap" }), CardEditError);
		applyLessonEdit(cloze, { text: "The {{c1::x}} and {{c2::y}}", front: "ignored: not a cloze field" });
		assert.equal(cloze.text, "The {{c1::x}} and {{c2::y}}");
		assert.equal("front" in cloze, false);
		applyLessonEdit(cloze, { deleted: true });
		assert.equal(cloze.deleted, true);
	});

	const ctx = { jobId: "crt_job", jobName: "Upper limb", courseId: "anatomy", statement: lessonStatements({ propositions: PROPOSITIONS, nodeSessions: NODE_SESSIONS }, "chat_a")[0]!, at: NOW.toISOString() };

	it("turns a basic draft into ONE core-knowledge card tied to its statement", () => {
		const draft: LessonDraft = { id: "p001-c01", page: 1, type: "basic", front: "Which nerve <passes>?", back: "The **median** nerve.", extra: "", deleted: false, include: true };
		const [card, ...more] = lessonStudyCards(draft, ctx);
		assert.equal(more.length, 0);
		assert.equal(card!.id, "crt_crt_job_p001-c01");
		assert.deepEqual([card!.kind, card!.core, card!.tier, card!.courseId], ["basic", true, 1, "anatomy"]);
		assert.deepEqual(card!.origin, { kind: "graph", nodeId: "n_median", jobId: "crt_job", draftId: "p001-c01" });
		assert.equal(card!.fields.Front, "Which nerve &lt;passes&gt;?");
		assert.equal(card!.fields.Back, "The <b>median</b> nerve.");
		assert.equal(card!.fields.Source, "Upper limb");
		assert.equal(card!.variant, undefined);
	});

	it("turns a cloze draft into one card per gap, siblings by the draft", () => {
		const draft: LessonDraft = { id: "p001-c02", page: 1, type: "cloze", text: "The {{c1::median nerve}} runs with {{c2::nine tendons}}.", extra: "", deleted: false, include: true };
		const cards = lessonStudyCards(draft, ctx);
		assert.deepEqual(cards.map((c) => [c.id, c.variant, c.kind]), [["crt_crt_job_p001-c02", 0, "cloze"], ["crt_crt_job_p001-c02_v1", 1, "cloze"]]);
		assert.ok(cards.every((c) => c.core && c.tier === 1));
		assert.equal(cards[0]!.fields.Text, "The {{c1::median nerve}} runs with {{c2::nine tendons}}.");
	});

	it("lists what a statement's cards already ask, as plain lines", () => {
		const base = { courseId: "c", tags: [], core: true, createdAt: "" };
		const cards: StudyCard[] = [
			{ ...base, id: "1", kind: "basic", fields: { Front: "Which nerve?<br>Really", Back: "The <b>median</b> &amp; more" }, origin: { kind: "graph", nodeId: "n_median" } },
			{ ...base, id: "2", kind: "cloze", fields: { Text: "The {{c1::median}} nerve" }, origin: { kind: "graph", nodeId: "n_median" } },
			{ ...base, id: "3", kind: "basic", fields: { Front: "other", Back: "x" }, origin: { kind: "graph", nodeId: "n_ulnar" } },
			{ ...base, id: "4", kind: "basic", fields: { Front: "gone", Back: "x" }, origin: { kind: "graph", nodeId: "n_median" }, suspended: true },
		];
		assert.deepEqual(existingCardTexts(cards, "n_median"), ["Which nerve? Really → The median & more", "The {{c1::median}} nerve"]);
	});
});

// ─── the service ─────────────────────────────────────────────────────────────

/** The statement text the prompt carries ("Aussage:\n<text>"), to answer per statement. */
const statementOf = (req: AskClaudeRequest): string => /Aussage:\n(.+)/.exec(req.prompt)?.[1] ?? "";

const scripted: AskClaude = async (req) => ({
	text: JSON.stringify({ cards: [{ type: "basic", front: `Question about: ${statementOf(req)}`, back: "Answer" }, { type: "cloze", text: `Gap {{c1::x}} for ${statementOf(req).length}` }], note: "" }),
	costUsd: 0,
	durationMs: 1,
});

function setup(over: Partial<LessonDeps> = {}) {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const create = createCreateStore(path.join(dir, "create"));
	const study = createStudyStore({ courses: path.join(dir, "courses.jsonl"), cards: path.join(dir, "cards.jsonl"), reviews: path.join(dir, "reviews.jsonl") });
	study.upsertCourse({ id: "anatomy", name: "Anatomy", bufferDays: 5, topics: ["Nerves", "Muscles"], createdAt: NOW.toISOString() });
	study.upsertCourse({ id: "bio", name: "Biology", bufferDays: 5, createdAt: NOW.toISOString() });
	const asked: AskClaudeRequest[] = [];
	const linked: { id: string; cardIds: string[] }[] = [];
	const records: Record<string, Pick<ChatRecord, "id" | "title" | "courseId">> = {
		chat_a: { id: "chat_a", title: "Upper limb nerves", courseId: "anatomy" },
		chat_b: { id: "chat_b", title: "Mixed lesson" },
	};
	const chats = {
		getChat: (id: string) => (records[id] ?? null) as ChatRecord | null,
		linkCards: (id: string, cardIds: readonly string[]) => {
			linked.push({ id, cardIds: [...cardIds] });
			return (records[id] ?? null) as ChatRecord | null;
		},
	} as unknown as ChatStore;
	const inner = over.ask ?? scripted;
	const deps: LessonDeps = {
		create,
		library: undefined as never,
		study,
		renderPage: async () => {
			throw new Error("not used");
		},
		pageLines: async () => [],
		documentText: async () => "",
		addPdf: async () => {
			throw new Error("not used");
		},
		now: () => NOW,
		retryDelayMs: 0,
		chats,
		graph: () => ({ propositions: PROPOSITIONS, nodeSessions: NODE_SESSIONS }),
		...over,
		ask: async (req) => {
			asked.push(req);
			return inner(req);
		},
	};
	return { deps, create, study, asked, linked };
}

const ALL_A = ["n_median", "n_ulnar", "n_radial"];

/** A job for lesson "chat_a" with all three statements; the run finished. */
async function runLesson(deps: LessonDeps, extra: object = {}) {
	const summary = createLessonJob({ chatId: "chat_a", statementIds: ALL_A, courseId: "anatomy", autostart: false, ...extra }, deps);
	await startLessonJob(summary.id, {}, deps).settled;
	return summary.id;
}

describe("the statements a form offers", () => {
	it("for a lesson: its propositions with the cards they already have, and the lesson's course", () => {
		const { deps, study } = setup();
		study.upsertCards([
			{ id: "k1", courseId: "anatomy", kind: "basic", fields: { Front: "q", Back: "a" }, tags: [], core: true, origin: { kind: "graph", nodeId: "n_median" }, createdAt: NOW.toISOString() },
		]);
		const source = lessonSource({ chatId: "chat_a" }, deps);
		assert.equal(source.title, "Upper limb nerves");
		assert.equal(source.chatId, "chat_a");
		assert.equal(source.courseId, "anatomy");
		assert.deepEqual(source.statements.map((s) => [s.nodeId, s.cards]), [["n_median", 1], ["n_ulnar", 0], ["n_radial", 0]]);
		assert.equal("courseId" in lessonSource({ chatId: "chat_b" }, deps), false);
	});

	it("for a graph pick: the nodes that still exist", () => {
		const { deps } = setup();
		const source = lessonSource({ nodeIds: ["n_other", "n_gone"] }, deps);
		assert.equal(source.title, "Graph selection");
		assert.equal("chatId" in source, false);
		assert.deepEqual(source.statements.map((s) => s.nodeId), ["n_other"]);
	});

	it("refuses an unknown lesson, a pick of nothing and a pick of gone nodes — cleanly", () => {
		const { deps } = setup();
		const status = (f: () => unknown) => {
			try {
				f();
			} catch (err) {
				return err instanceof CreateInputError ? err.status : "crash";
			}
			return "no error";
		};
		assert.equal(status(() => lessonSource({ chatId: "nope" }, deps)), 404);
		assert.equal(status(() => lessonSource({}, deps)), 400);
		assert.equal(status(() => lessonSource({ nodeIds: [] }, deps)), 400);
		assert.equal(status(() => lessonSource({ nodeIds: ["n_gone"] }, deps)), 404);
	});
});

describe("making a job", () => {
	it("keeps the chosen statements (in graph order) as one pending page each", () => {
		const { deps, create } = setup();
		const summary = createLessonJob({ chatId: "chat_a", statementIds: ["n_radial", "n_median"], courseId: "anatomy", autostart: false }, deps);
		const job = create.get(summary.id)!;
		assert.equal(job.kind, "lesson");
		assert.equal(job.name, "Upper limb nerves");
		assert.equal(summary.kind, "lesson");
		assert.equal(summary.courseId, "anatomy");
		assert.equal(summary.chatId, "chat_a");
		assert.equal("lectureId" in summary, false);
		assert.equal(summary.total, 2);
		assert.equal(summary.state, "queued");
		if (job.kind !== "lesson") throw new Error("kind");
		assert.deepEqual(job.statements.map((s) => s.nodeId), ["n_median", "n_radial"]);
		assert.deepEqual(Object.keys(job.pages), ["1", "2"]);
		assert.equal(job.nPages, 2);
		assert.match(job.courseNote ?? "", /Anatomy/);
		assert.match(job.courseNote ?? "", /Nerves; Muscles/);
	});

	it("refuses what cannot make a job: no statements, a stale one, too many, an unknown course", () => {
		const { deps } = setup();
		const status = (input: object) => {
			try {
				createLessonJob({ chatId: "chat_a", statementIds: ALL_A, courseId: "anatomy", autostart: false, ...input }, deps);
			} catch (err) {
				return err instanceof CreateInputError ? err.status : "crash";
			}
			return "no error";
		};
		assert.equal(status({ statementIds: [] }), 400);
		assert.equal(status({ statementIds: ["n_other"] }), 404); // not a statement of this lesson
		assert.equal(status({ statementIds: ["n_median", "n_gone"] }), 404);
		assert.equal(status({ statementIds: Array.from({ length: 201 }, (_, i) => `n_${i}`) }), 400);
		assert.equal(status({ courseId: "nope" }), 404);
		assert.equal(status({ chatId: "nope" }), 404);
		assert.equal(status({}), "no error");
	});

	it("a graph pick makes a job without a lesson", () => {
		const { deps, create } = setup();
		const summary = createLessonJob({ nodeIds: ["n_other", "n_median"], statementIds: ["n_median"], courseId: "bio", autostart: false }, deps);
		const job = create.get(summary.id)!;
		assert.equal(job.name, "Graph selection");
		assert.equal("chatId" in summary, false);
		assert.equal(job.kind === "lesson" && job.chatId, undefined);
	});
});

describe("running a job", () => {
	it("asks once per statement with the subject, the language and the other statements, and keeps the drafts", async () => {
		const { deps, asked, create } = setup();
		const id = await runLesson(deps);
		assert.equal(asked.length, 3);
		const first = asked.find((r) => statementOf(r).startsWith("The median"))!;
		assert.match(first.system, /bis zu 3 Anki-Karten/);
		assert.match(first.system, /Write ALL cards in English/);
		assert.match(first.system, /Fach „Anatomy“/);
		assert.match(first.prompt, /Aussage 1 von 3/);
		assert.match(first.prompt, /Name \(nur Etikett\): Median nerve/);
		assert.match(first.prompt, /Andere Aussagen derselben Lerneinheit/);
		assert.match(first.prompt, /Guyon's canal/);
		assert.doesNotMatch(first.prompt, /Aussage:\nThe ulnar/); // the others are context, not the subject
		assert.equal(first.model, "sonnet");
		assert.equal(create.get(id)!.state, "done");

		const detail = getLessonJob(id, deps);
		assert.deepEqual(detail.pages.map((p) => [p.page, p.status, p.cards.length]), [[1, "done", 2], [2, "done", 2], [3, "done", 2]]);
		assert.equal(detail.pages[0]!.statement.nodeId, "n_median");
		assert.equal(detail.job.drafts, 6);
		assert.equal(detail.job.adopted, 0);
		assert.equal(detail.chatId, "chat_a");
		const pageOne = deps.create.readLessonPage(id, 1)!;
		assert.equal(pageOne.nodeId, "n_median");
		assert.deepEqual(pageOne.cards.map((c) => c.id), ["p001-c01", "p001-c02"]);
	});

	it("names the cards that already exist so the model does not repeat them", async () => {
		const { deps, asked, study } = setup();
		study.upsertCards([
			{ id: "k1", courseId: "anatomy", kind: "basic", fields: { Front: "Which nerve is in the tunnel?", Back: "Median" }, tags: [], core: true, origin: { kind: "graph", nodeId: "n_median" }, createdAt: NOW.toISOString() },
		]);
		await runLesson(deps);
		const first = asked.find((r) => statementOf(r).startsWith("The median"))!;
		assert.match(first.prompt, /Zu dieser Aussage gibt es schon diese Karten/);
		assert.match(first.prompt, /- Which nerve is in the tunnel\? → Median/);
		assert.doesNotMatch(asked.find((r) => statementOf(r).startsWith("The ulnar"))!.prompt, /schon diese Karten/);
	});

	it("takes the settings: language, cards per statement, model", async () => {
		const { deps, asked } = setup();
		await runLesson(deps, { settings: { language: "de", maxPerStatement: 1, model: "opus" } });
		assert.ok(asked.every((r) => r.model === "opus" && /bis zu 1 Anki-Karten/.test(r.system) && /Schreibe ALLE Karten auf Deutsch/.test(r.system)));
		const { deps: d2, create } = setup();
		const id = await runLesson(d2, { settings: { maxPerStatement: 1 } });
		assert.ok(getLessonJob(id, d2).pages.every((p) => p.cards.length === 1));
		assert.equal(create.get(id)!.state, "done");
	});

	it("a failed statement is an error page; the others still finish; a retry runs just that one", async () => {
		let failing = true;
		const { deps, create } = setup({
			ask: async (req) => {
				if (failing && statementOf(req).startsWith("The ulnar")) throw new ClaudeAskError("model hiccup", "other");
				return scripted(req);
			},
		});
		const id = await runLesson(deps);
		const job = create.get(id)!;
		assert.equal(job.state, "done"); // the run is over; the failed statement waits for a retry
		assert.deepEqual(Object.values(job.pages).map((p) => p.status), ["done", "error", "done"]);
		assert.match(job.pages["2"]!.error ?? "", /model hiccup/);
		assert.equal(getLessonJob(id, deps).pages[1]!.cards.length, 0);

		failing = false;
		const retried = startLessonJob(id, { pages: [2] }, deps);
		assert.equal(retried.started, true);
		await retried.settled;
		assert.equal(create.get(id)!.state, "done");
		assert.equal(getLessonJob(id, deps).pages[1]!.cards.length, 2);
		assert.throws(() => startLessonJob(id, { pages: [9] }, deps), CreateInputError);
	});

	it("a lost sign-in stops the whole run and says so", async () => {
		const { deps, create, asked } = setup({
			ask: async () => {
				throw new ClaudeAskError("Please sign in", "auth");
			},
		});
		const id = await runLesson(deps, { settings: { concurrency: 1 } });
		const job = create.get(id)!;
		assert.equal(job.state, "stopped");
		assert.match(job.blocked ?? "", /sign in/i);
		assert.equal(asked.length, 1); // the rest was not even tried
		assert.deepEqual(Object.values(job.pages).map((p) => p.status), ["pending", "pending", "pending"]);
	});

	it("a statement without a card worth making keeps the model's reason", async () => {
		const { deps } = setup({ ask: async () => ({ text: JSON.stringify({ cards: [], note: "Too vague to ask." }), costUsd: 0, durationMs: 1 }) });
		const id = await runLesson(deps);
		const page = getLessonJob(id, deps).pages[0]!;
		assert.deepEqual([page.status, page.cards.length, page.note], ["done", 0, "Too vague to ask."]);
		assert.equal(deps.create.get(id)!.pages["1"]!.skipped, true);
	});

	it("an unreadable answer gets one repair retry", async () => {
		let n = 0;
		const { deps } = setup({
			ask: async (req) => {
				n++;
				return n === 1 ? { text: "sorry, here you go: nothing", costUsd: 0, durationMs: 1 } : scripted(req);
			},
		});
		const id = await runLesson(deps, { settings: { concurrency: 1 } });
		assert.equal(getLessonJob(id, deps).pages[0]!.status, "done");
	});

	it("reports a run cut off by a restart as interrupted, and resumes it", async () => {
		const { deps, create } = setup();
		const summary = createLessonJob({ chatId: "chat_a", statementIds: ALL_A, courseId: "anatomy", autostart: false }, deps);
		create.update(summary.id, (j) => {
			j.state = "running";
			j.pages["1"]!.status = "running";
		});
		assert.equal(getLessonJob(summary.id, deps).job.state, "interrupted"); // no live run behind "running"
		assert.equal(create.get(summary.id)!.pages["1"]!.status, "pending");
		await startLessonJob(summary.id, {}, deps).settled;
		assert.equal(create.get(summary.id)!.state, "done");
		assert.equal(stopCreateJob(summary.id), false);
	});
});

describe("drafts", () => {
	it("edits a card, throws one away and brings it back; adopted drafts are left to Study", async () => {
		const { deps } = setup();
		const id = await runLesson(deps);
		const card = patchLessonCard(id, "p001-c01", { front: "Edited question", include: false }, deps);
		assert.deepEqual([card.type === "basic" && card.front, card.include, card.edited], ["Edited question", false, true]);
		assert.equal(getLessonJob(id, deps).pages[0]!.cards[0]!.include, false);
		assert.equal(patchLessonCard(id, "p001-c02", { deleted: true }, deps).deleted, true);
		assert.equal(getLessonJob(id, deps).job.drafts, 5);
		assert.equal(patchLessonCard(id, "p001-c02", { deleted: false }, deps).deleted, false);

		assert.throws(() => patchLessonCard(id, "p001-c01", { back: "" }, deps), (e) => e instanceof CreateInputError && e.status === 400);
		assert.throws(() => patchLessonCard(id, "p001-c09", {}, deps), (e) => e instanceof CreateInputError && e.status === 404);
		assert.throws(() => patchLessonCard(id, "x", {}, deps), (e) => e instanceof CreateInputError && e.status === 404);
		assert.throws(() => patchLessonCard(id, "p009-c01", {}, deps), (e) => e instanceof CreateInputError && e.status === 404);

		adoptLessonCards(id, { courseId: "anatomy", cardIds: ["p001-c02"] }, deps);
		assert.throws(() => patchLessonCard(id, "p001-c02", { front: "x" }, deps), (e) => e instanceof CreateInputError && e.status === 409);
	});

	it("selects and unselects many at once, never an adopted one", async () => {
		const { deps } = setup();
		const id = await runLesson(deps);
		assert.equal(setLessonInclude(id, { cardIds: ["p001-c01", "p002-c01", "p002-c02", "p404-c01"], include: false }, deps), 3);
		assert.equal(setLessonInclude(id, { cardIds: ["p001-c01"], include: false }, deps), 0); // already so
		adoptLessonCards(id, { courseId: "anatomy", cardIds: ["p002-c01"] }, deps);
		assert.equal(setLessonInclude(id, { cardIds: ["p002-c01"], include: true }, deps), 0);
		assert.equal(deps.create.readLessonPage(id, 2)!.cards[0]!.include, false);
	});
});

describe("adopting", () => {
	it("makes core-knowledge cards (tier 1) tied to their statements, and tells the lesson", async () => {
		const { deps, study, linked, create } = setup();
		const id = await runLesson(deps);
		const result = adoptLessonCards(id, { courseId: "anatomy" }, deps);
		assert.deepEqual(result, { adopted: 6, skipped: 0 });

		const cards = study.readCards();
		assert.equal(cards.length, 6);
		assert.ok(cards.every((c) => c.core === true && c.tier === 1 && c.courseId === "anatomy" && c.origin.kind === "graph"));
		const median = cards.filter((c) => c.origin.kind === "graph" && c.origin.nodeId === "n_median");
		assert.deepEqual(median.map((c) => c.kind).sort(), ["basic", "cloze"]);
		assert.ok(median.every((c) => c.origin.kind === "graph" && c.origin.jobId === id));

		assert.equal(linked.length, 1);
		assert.equal(linked[0]!.id, "chat_a");
		assert.deepEqual([...linked[0]!.cardIds].sort(), cards.map((c) => c.id).sort());
		const job = getLessonJob(id, deps);
		assert.equal(job.job.adopted, 6);
		assert.ok(job.pages.every((p) => p.cards.every((c) => c.adopted?.courseId === "anatomy")));
		assert.equal(create.get(id)!.state, "done");
	});

	it("adopts only what is selected, or only what is named", async () => {
		const { deps, study } = setup();
		const id = await runLesson(deps);
		setLessonInclude(id, { cardIds: ["p001-c01", "p001-c02", "p002-c01", "p002-c02"], include: false }, deps);
		assert.equal(adoptLessonCards(id, { courseId: "anatomy" }, deps).adopted, 2); // page 3 only
		assert.deepEqual(study.readCards().map((c) => c.origin.kind === "graph" && c.origin.draftId).sort(), ["p003-c01", "p003-c02"]);
		// named cards are taken whatever their selection
		assert.equal(adoptLessonCards(id, { courseId: "anatomy", cardIds: ["p001-c01"] }, deps).adopted, 1);
		assert.equal(study.readCards().length, 3);
	});

	it("never makes a draft a card twice, and leaves thrown-away drafts out", async () => {
		const { deps, study, linked } = setup();
		const id = await runLesson(deps);
		patchLessonCard(id, "p003-c02", { deleted: true }, deps);
		assert.deepEqual(adoptLessonCards(id, { courseId: "anatomy" }, deps), { adopted: 5, skipped: 1 });
		assert.deepEqual(adoptLessonCards(id, { courseId: "anatomy" }, deps), { adopted: 0, skipped: 6 });
		assert.equal(study.readCards().length, 5);
		assert.equal(linked.length, 1); // nothing new the second time
	});

	it("a cloze with two gaps becomes two sibling cards, and a graph card's siblings are its own draft's", async () => {
		const { deps, study } = setup({
			ask: async () => ({ text: JSON.stringify({ cards: [{ type: "cloze", text: "The {{c1::median nerve}} runs with {{c2::nine tendons}}." }] }), costUsd: 0, durationMs: 1 }),
		});
		const id = await runLesson(deps, { statementIds: ["n_median"] });
		assert.equal(adoptLessonCards(id, { courseId: "bio" }, deps).adopted, 1);
		assert.equal(study.readCards().length, 2);
		assert.deepEqual(study.readCards().map((c) => c.variant).sort(), [0, 1]);
		assert.ok(study.readCards().every((c) => c.courseId === "bio"));
	});

	it("a graph pick adopts without a lesson to tell", async () => {
		const { deps, linked } = setup();
		const summary = createLessonJob({ nodeIds: ["n_other"], statementIds: ["n_other"], courseId: "anatomy", autostart: false }, deps);
		await startLessonJob(summary.id, {}, deps).settled;
		assert.equal(adoptLessonCards(summary.id, { courseId: "anatomy" }, deps).adopted, 2);
		assert.deepEqual(linked, []);
	});

	it("refuses an unknown course, and a job of another kind", async () => {
		const { deps } = setup();
		const id = await runLesson(deps);
		assert.throws(() => adoptLessonCards(id, { courseId: "nope" }, deps), (e) => e instanceof CreateInputError && e.status === 404);
		assert.throws(() => adoptLessonCards("crt_unknown", { courseId: "anatomy" }, deps), (e) => e instanceof CreateInputError && e.status === 404);
	});

	it("a re-run of a statement keeps the cards already adopted and numbers the new drafts after them", async () => {
		const { deps, study } = setup();
		const id = await runLesson(deps);
		adoptLessonCards(id, { courseId: "anatomy", cardIds: ["p001-c01"] }, deps);
		await startLessonJob(id, { pages: [1] }, deps).settled;
		const page = deps.create.readLessonPage(id, 1)!;
		assert.deepEqual(page.cards.map((c) => [c.id, Boolean(c.adopted)]), [["p001-c01", true], ["p001-c03", false], ["p001-c04", false]]);
		assert.equal(study.readCards().length, 1);
	});
});
