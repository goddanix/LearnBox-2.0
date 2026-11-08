/**
 * Study ↔ lesson links (Learnbox 2.0, Slice 9a) — deterministic, no network, no model:
 *
 *   1. a card as plain text (every kind), capped
 *   2. the weak-spot list: lapses from the FSRS fold, order, filters
 *   3. the study-context marker: the approved wording, the view projection, the input class
 *   4. the graph through one course
 *   5. the server functions against a throw-away store
 *   6. the routes: lesson birth with a course and cards, the course change, the weak list
 *
 * The data dir is a temp dir set BEFORE the first import of config.ts (LH_DATA_DIR is read at
 * module load — see data-dir-seam.test.ts); the routes and stores are imported afterwards.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { StudyCard, StudyCourse, StudyReview } from "../src/core/contracts/study.ts";
import { LINK_TEXT_CAP, type StudyContextData } from "../src/core/contracts/study-link.ts";
import { courseNodeIds } from "../src/core/graph-course.ts";
import { nativeInputCause, type LhMarkerMessage } from "../src/core/native-messages.ts";
import { groupReviews } from "../src/core/study-queue.ts";
import {
	buildStudyContext,
	cleanSubdecks,
	linkCard,
	newStudyContextMessage,
	plainText,
	studyContextText,
	suggestedFirstMessage,
	weakSpots,
} from "../src/core/study-link.ts";
import { projectView } from "../src/core/view.ts";

const NOW = new Date(2026, 10, 5, 10, 0, 0);
const TODAY = "2026-11-05";

const course = (over: Partial<StudyCourse> = {}): StudyCourse => ({ id: "anat", name: "Anatomy", bufferDays: 5, createdAt: NOW.toISOString(), ...over });

function card(id: string, over: Partial<StudyCard> = {}): StudyCard {
	return {
		id,
		courseId: "anat",
		kind: "basic",
		fields: { Front: `Front ${id}`, Back: `Back ${id}` },
		tags: [],
		core: false,
		origin: { kind: "manual" },
		createdAt: NOW.toISOString(),
		...over,
	};
}

/** Learned, then forgotten `lapses` times (each Again comes long after the card was due). */
function reviewsWithLapses(cardId: string, lapses: number): StudyReview[] {
	const out: StudyReview[] = [];
	let t = Date.UTC(2026, 8, 1);
	const push = (grade: 1 | 3, gap: number) => {
		t += gap;
		out.push({ cardId, at: new Date(t).toISOString(), grade });
	};
	push(3, 0);
	push(3, 11 * 60_000);
	for (let i = 0; i < lapses; i++) {
		push(1, 40 * 86_400_000);
		push(3, 11 * 60_000);
		push(3, 11 * 60_000);
	}
	return out;
}

describe("a card as plain text", () => {
	it("drops tags, keeps the words, turns pictures into [figure] and decodes entities", () => {
		assert.equal(plainText('<div class="q">Which <b>nerve</b> &amp; vessel?<br>Both.</div><img src="x.png">'), "Which nerve & vessel? Both. [figure]");
		assert.equal(plainText("a&nbsp;&lt;b&gt;&nbsp;"), "a <b>");
	});

	it("reads a basic card forwards and a reversed one backwards", () => {
		assert.deepEqual(linkCard(card("a"), 3), { id: "a", front: "Front a", back: "Back a", lapses: 3 });
		assert.deepEqual(linkCard(card("a", { variant: 1 }), 0), { id: "a", front: "Back a", back: "Front a", lapses: 0 });
	});

	it("hides only the active gap of a cloze on the front, with the hint, and fills it on the back", () => {
		const c = card("c", { kind: "cloze", variant: 1, fields: { Text: "The {{c1::radial}} nerve and the {{c2::ulnar::which?}} nerve", Extra: "Both arm nerves" } });
		const l = linkCard(c, 2);
		assert.equal(l.front, "The radial nerve and the [which?] nerve");
		assert.equal(l.back, "The radial nerve and the ulnar nerve Both arm nerves");
		assert.equal(linkCard(card("c0", { kind: "cloze", fields: { Text: "A {{c1::x}} b" } }), 1).front, "A [...] b");
	});

	it("reads an image occlusion card by its header and answer, and an MCQ card by question, options and key", () => {
		const occ = card("o", { kind: "occlusion", fields: { Header: "Skull", QuestionImage: '<img src="q.png">', AnswerImage: '<img src="a.png">', Answer: "Frontal bone" } });
		assert.deepEqual(linkCard(occ, 4), { id: "o", front: "Skull", back: "Frontal bone Skull", lapses: 4 });
		const mcq = card("m", { kind: "mcq", fields: { Question: "Which are bones?", OptionA: "Femur", OptionB: "Liver", OptionC: "", OptionD: "Tibia", Correct: "A, D", Explanation: "Liver is an organ." } });
		assert.deepEqual(linkCard(mcq, 1), { id: "m", front: "Which are bones? A. Femur B. Liver D. Tibia", back: "Correct: A, D. Liver is an organ.", lapses: 1 });
	});

	it("cuts long faces", () => {
		const l = linkCard(card("long", { fields: { Front: "x".repeat(900), Back: "y" } }), 0);
		assert.equal(l.front.length, LINK_TEXT_CAP);
		assert.ok(l.front.endsWith("…"));
	});
});

describe("the weak-spot list", () => {
	const cards = [card("two"), card("three"), card("one"), card("none"), card("sus", { suspended: true }), card("other", { courseId: "bio" }), card("fresh")];
	const reviews = groupReviews([
		...reviewsWithLapses("two", 2),
		...reviewsWithLapses("three", 3),
		...reviewsWithLapses("one", 1),
		...reviewsWithLapses("none", 0),
		...reviewsWithLapses("sus", 5),
		...reviewsWithLapses("other", 5),
	]);

	it("lists the cards with at least two lapses, most first, without suspended cards, other courses or unreviewed cards", () => {
		const weak = weakSpots(course(), cards, reviews, TODAY);
		assert.deepEqual(weak.map((c) => [c.id, c.lapses]), [["three", 3], ["two", 2]]);
		assert.equal(weak[0]!.front, "Front three");
	});

	it("honours the minimum and the limit, and breaks ties by difficulty then id", () => {
		assert.deepEqual(weakSpots(course(), cards, reviews, TODAY, { minLapses: 1 }).map((c) => c.id), ["three", "two", "one"]);
		assert.deepEqual(weakSpots(course(), cards, reviews, TODAY, { minLapses: 1, limit: 2 }).map((c) => c.id), ["three", "two"]);
		const tie = groupReviews([...reviewsWithLapses("b", 2), ...reviewsWithLapses("a", 2)]);
		assert.deepEqual(weakSpots(course(), [card("b"), card("a")], tie, TODAY).map((c) => c.id), ["a", "b"]);
	});

	it("counts a taken-back review as if it never happened", () => {
		const own = reviewsWithLapses("two", 2);
		const last = own.at(-1)!;
		const undone = groupReviews([...own, { cardId: "two", at: new Date(Date.parse(last.at) + 1000).toISOString(), grade: 3, undo: true }]);
		assert.equal(weakSpots(course(), [card("two")], undone, TODAY).length, 1, "undoing the last Good keeps both lapses");
		const undoneAgain = groupReviews(reviewsWithLapses("two", 2).slice(0, -3));
		assert.equal(weakSpots(course(), [card("two")], undoneAgain, TODAY).length, 0, "without the second Again only one lapse is left");
	});
});

describe("the study-context marker", () => {
	const data = (over: Partial<Parameters<typeof buildStudyContext>[0]> = {}): StudyContextData =>
		buildStudyContext({
			course: course({ topics: ["Arm", "Leg"], deadline: "2026-12-14" }),
			today: TODAY,
			due: 143,
			newToday: 12,
			weakAll: [
				{ id: "w1", front: "Radial nerve injury", back: "wrist drop", lapses: 6 },
				{ id: "w2", front: "Ulnar nerve", back: "claw hand", lapses: 4 },
			],
			picked: [{ id: "w1", front: "Radial nerve injury", back: "wrist drop", lapses: 6 }],
			...over,
		});

	it("builds the payload: exam days, topics, the weak list without the picked cards", () => {
		const d = data();
		assert.equal(d.course.daysToExam, 39);
		assert.deepEqual(d.course.topics, ["Arm", "Leg"]);
		assert.deepEqual(d.weak.map((c) => c.id), ["w2"]);
		assert.deepEqual(d.cards.map((c) => c.id), ["w1"]);
		assert.equal(buildStudyContext({ course: course(), today: TODAY, due: 0, newToday: 0, weakAll: [], picked: [] }).course.daysToExam, null);
	});

	it("tells the model the course, the exam, the state, the weak cards and the picked cards in the approved wording", () => {
		const text = studyContextText(data());
		assert.match(text, /^\[Session context\] — the learner started this session from their flashcards\./);
		assert.match(text, /Course: Anatomy — exam on 2026-12-14 \(39 days left\)\./);
		assert.match(text, /Topics: Arm; Leg$/m);
		assert.match(text, /Study state: 143 cards due, 12 new today\./);
		assert.match(text, /Weakest cards of the course \(most lapses\):\n- "Ulnar nerve" \(4 lapses\)/);
		assert.match(text, /Cards the learner picked for this lesson \(they keep getting these wrong\):\n- \[w1\] Front: Radial nerve injury \| Back: wrist drop \| 6 lapses/);
		assert.match(text, /These cards show what the learner was asked to memorise, NOT what they understand — find out where it breaks down before teaching\.$/);
	});

	it("words a course-only lesson, no exam, a passed or a same-day exam, and strict topics", () => {
		const bare = studyContextText(buildStudyContext({ course: course(), today: TODAY, due: 1, newToday: 0, weakAll: [], picked: [] }));
		assert.match(bare, /^\[Session context\] — the course this session belongs to\./);
		assert.match(bare, /Course: Anatomy — no exam date set\./);
		assert.match(bare, /Study state: 1 card due, 0 new today\./);
		assert.ok(!bare.includes("These cards show"), "no cards, nothing to caution about");
		const at = (deadline: string, strictTopics = false) =>
			studyContextText(buildStudyContext({ course: course({ deadline, topics: ["A"], strictTopics }), today: TODAY, due: 0, newToday: 0, weakAll: [], picked: [] }));
		assert.match(at("2026-11-06"), /exam on 2026-11-06 \(1 day left\)\./);
		assert.match(at(TODAY), /the exam is today \(2026-11-05\)\./);
		assert.match(at("2026-11-01"), /the exam was on 2026-11-01 \(passed\)\./);
		assert.match(at("2026-12-01", true), /Topics: A \(only these topics count\)/);
	});

	it("names the subdecks a lesson is limited to (Slice 10h), the nameless one as 'no subdeck', and says nothing without them", () => {
		const limited = data({ subdecks: ["W1 Head", ""] });
		assert.deepEqual(limited.subdecks, ["W1 Head", ""]);
		assert.match(studyContextText(limited), /^Subdecks in this lesson: W1 Head; no subdeck\.$/m);
		assert.ok(studyContextText(limited).indexOf("Topics: Arm; Leg") < studyContextText(limited).indexOf("Subdecks in this lesson"), "after the course's topics");
		for (const none of [data(), data({ subdecks: [] })]) {
			assert.equal("subdecks" in none, false);
			assert.ok(!studyContextText(none).includes("Subdecks in this lesson"));
		}
	});

	it("reads the subdecks of a request: strings only, once each, in order — anything else limits nothing", () => {
		assert.deepEqual(cleanSubdecks(["W2", "W1", "W2", "", 3, null, {}]), ["W2", "W1", ""]);
		for (const bad of [undefined, null, "W1", { 0: "W1" }, 7, Array.from({ length: 501 }, (_, i) => `t${i}`)]) assert.deepEqual(cleanSubdecks(bad), [], String(bad).slice(0, 20));
		assert.equal(cleanSubdecks(Array.from({ length: 500 }, (_, i) => `t${i}`)).length, 500);
		assert.deepEqual(cleanSubdecks(["x".repeat(301), "ok"]), ["ok"], "a name that long is not a subdeck");
	});

	it("is a custom message that is neutral input, projected as a data card, and never learner speech", () => {
		const d = data();
		const marker = newStudyContextMessage(d);
		assert.equal(marker.role, "custom");
		assert.equal(marker.customType, "study-context");
		assert.equal(marker.display, true);
		assert.equal(marker.content, studyContextText(d));
		assert.deepEqual(marker.details, d);
		assert.equal(nativeInputCause(marker as never, []), "neutral");
		const [projected] = projectView([marker as LhMarkerMessage & { id: string }]);
		assert.equal(projected?.role, "user");
		assert.equal(projected?.parts[0]?.type, "data-study-context");
		assert.deepEqual((projected?.parts[0] as { data: unknown }).data, d);
	});

	it("suggests the first message in the singular and the plural", () => {
		assert.match(suggestedFirstMessage(1), /^I keep getting this card wrong\. Find out where my understanding breaks down, then teach me what I'm missing\.$/);
		assert.match(suggestedFirstMessage(3), /^I keep getting these cards wrong\./);
	});
});

describe("the graph through one course", () => {
	const node = (id: string) => ({ id, name: id, statement: id, aliases: [], createdAt: "", provenance: [] });
	const snapshot = {
		propositions: [node("n1"), node("n2"), node("n3")],
		nodeSessions: { n1: ["c1"], n2: ["c1", "c2"], n3: ["c2"] },
		chains: [
			{ id: "arg_a", premises: ["n1"], conclusion: "n2", provenance: [], createdAt: "" },
			{ id: "arg_b", premises: ["n2"], conclusion: "n3", provenance: [], createdAt: "" },
		],
	};

	it("keeps the propositions the course's lessons touched and the arguments entirely among them", () => {
		assert.deepEqual([...courseNodeIds(snapshot, new Set(["c1"]))].sort(), ["arg_a", "n1", "n2"]);
		assert.deepEqual([...courseNodeIds(snapshot, new Set(["c2"]))].sort(), ["arg_b", "n2", "n3"]);
		assert.deepEqual([...courseNodeIds(snapshot, new Set(["c1", "c2"]))].sort(), ["arg_a", "arg_b", "n1", "n2", "n3"]);
		assert.equal(courseNodeIds(snapshot, new Set()).size, 0);
	});
});

// ─── the server, the stores and the routes ───────────────────────────────────

let dir: string;
let stores: typeof import("../src/server/stores.ts");
let service: typeof import("../src/server/study-link.ts");
let study: typeof import("../src/server/study.ts");

before(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-study-link-"));
	process.env.LH_DATA_DIR = dir;
	stores = await import("../src/server/stores.ts");
	service = await import("../src/server/study-link.ts");
	study = await import("../src/server/study.ts");
});

after(() => {
	delete process.env.LH_DATA_DIR;
	fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	for (const sub of ["study", "chats", "graph"]) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
	const s = stores.stores.studyStore;
	s.upsertCourse({ id: "anat", name: "Anatomy", topics: ["Arm"], deadline: "2099-01-01", bufferDays: 5, createdAt: NOW.toISOString() });
	s.upsertCourse({ id: "bio", name: "Biology", bufferDays: 5, createdAt: NOW.toISOString() });
	s.upsertCards([card("two"), card("three"), card("one"), card("new1"), card("bio1", { courseId: "bio" })]);
	for (const r of [...reviewsWithLapses("two", 2), ...reviewsWithLapses("three", 3), ...reviewsWithLapses("one", 1), ...reviewsWithLapses("bio1", 4)]) s.appendReview(r);
});

describe("the server functions", () => {
	it("lists a course's weak spots and 404s an unknown course", () => {
		const out = service.studyWeakSpots("anat", NOW);
		assert.deepEqual(out.cards.map((c) => [c.id, c.lapses]), [["three", 3], ["two", 2]]);
		assert.throws(() => service.studyWeakSpots("nope", NOW), (e: unknown) => e instanceof study.StudyInputError && e.status === 404);
	});

	it("reads picked cards from the ledger, once each, and refuses unknown, foreign or too many cards", () => {
		assert.deepEqual(service.studyLinkCards("anat", ["three", "three", "two"], NOW).map((c) => c.id), ["three", "two"]);
		for (const bad of [["missing"], ["bio1"]]) {
			assert.throws(() => service.studyLinkCards("anat", bad, NOW), (e: unknown) => e instanceof study.StudyInputError && e.status === 404);
		}
		assert.throws(() => service.studyLinkCards("anat", Array.from({ length: 13 }, (_, i) => `c${i}`), NOW), (e: unknown) => e instanceof study.StudyInputError && e.status === 400);
		assert.deepEqual(service.studyLinkCards("anat", "not a list", NOW), []);
	});

	it("builds the marker data: today's counts, the exam, the weak list without the picked cards", () => {
		const later = new Date(2027, 5, 1, 10, 0, 0); // long after the reviews: every reviewed card is due
		const data = service.studyContextFor({ courseId: "anat", cardIds: ["three"] }, later);
		assert.equal(data.course.name, "Anatomy");
		assert.ok(data.course.daysToExam! > 1000);
		assert.deepEqual(data.cards.map((c) => c.id), ["three"]);
		assert.deepEqual(data.weak.map((c) => c.id), ["two"]);
		assert.equal(data.newToday, 1, "only the never-reviewed card is new today");
		assert.equal(data.due, 3, "the three reviewed cards of the course are due long after their last review");
	});
});

describe("a lesson limited to subdecks (Slice 10h)", () => {
	const later = new Date(2027, 5, 1, 10, 0, 0); // long after the reviews: every reviewed card is due
	beforeEach(() => {
		const s = stores.stores.studyStore;
		s.upsertCards([card("two", { topic: "W1" }), card("three", { topic: "W2" }), card("one"), card("new1", { topic: "W1" })]);
	});

	it("takes the state and the weak cards from those subdecks only, and says which they are", () => {
		const whole = service.studyContextFor({ courseId: "anat" }, later);
		assert.deepEqual(whole.weak.map((c) => c.id), ["three", "two"]);
		assert.equal(whole.subdecks, undefined);
		const w1 = service.studyContextFor({ courseId: "anat", topics: ["W1"] }, later);
		assert.deepEqual(w1.subdecks, ["W1"]);
		assert.deepEqual(w1.weak.map((c) => c.id), ["two"], "three is of W2");
		assert.equal(w1.due, 1, "only two of W1 was reviewed");
		assert.equal(w1.newToday, 1, "new1 of W1");
		const rest = service.studyContextFor({ courseId: "anat", topics: ["W2", ""] }, later);
		assert.deepEqual(rest.weak.map((c) => c.id), ["three"]);
		assert.deepEqual([rest.due, rest.newToday], [2, 0], "three and one, both reviewed; the nameless subdeck is the cards without a topic");
	});

	it("picks cards from the ledger as before — a picked card of another subdeck is still picked", () => {
		const picked = service.studyContextFor({ courseId: "anat", cardIds: ["three"], topics: ["W1"] }, later);
		assert.deepEqual(picked.cards.map((c) => c.id), ["three"]);
		assert.deepEqual(picked.weak.map((c) => c.id), ["two"]);
		assert.deepEqual(service.studyContextFor({ courseId: "bio", topics: ["W1"] }, later).weak, [], "the list names subdecks of the course asked for: Biology's only card has none");
		assert.deepEqual(service.studyContextFor({ courseId: "bio", topics: [""] }, later).weak.map((c) => c.id), ["bio1"]);
	});

	it("ignores something that is not a list", () => {
		assert.equal(service.studyContextFor({ courseId: "anat", topics: "W1" }, later).subdecks, undefined);
		assert.deepEqual(service.studyContextFor({ courseId: "anat", topics: [] }, later).weak.map((c) => c.id), ["three", "two"]);
	});
});

describe("opening a named card", () => {
	// A course of cards that were never reviewed: any of them can be shown, and none has a history
	// that depends on the clock.
	beforeEach(() => {
		stores.stores.studyStore.upsertCourse({ id: "fresh", name: "Fresh", bufferDays: 5, createdAt: NOW.toISOString() });
		stores.stores.studyStore.upsertCards([
			...["o1", "o2", "o3"].map((id) => card(id, { courseId: "fresh" })),
			card("osus", { courseId: "fresh", suspended: true }),
		]);
	});
	const next = (open?: string) => study.studyNext("fresh", 0, NOW, undefined, open).card?.id;
	const queued = () => next()!;
	/** A card the queue would not have shown first, so opening it proves the parameter works. */
	const other = () => ["o1", "o2", "o3"].find((id) => id !== queued())!;

	it("shows exactly that card first, and the queue's pick without one", () => {
		assert.ok(["o1", "o2", "o3"].includes(queued()));
		for (const id of ["o1", "o2", "o3"]) assert.equal(next(id), id);
	});

	it("falls back to the queue for an unknown card, a card of another course or a suspended one", () => {
		for (const stale of ["nope", "bio1", "osus", ""]) assert.equal(next(stale), queued(), `stale link ${JSON.stringify(stale)}`);
	});

	it("is the card= parameter of GET /api/study/next", async () => {
		const route = await import("../app/api/study/next/route.ts");
		const get = async (query: string) => ((await (await route.GET(new Request(`http://localhost/api/study/next?${query}`))).json()) as { card: { id: string } | null }).card?.id;
		const target = other();
		assert.equal(await get(`course=fresh&step=0&card=${target}`), target);
		assert.notEqual(await get("course=fresh&step=0"), target);
		assert.notEqual(await get("course=fresh&step=0&card=bio1"), "bio1");
	});
});

describe("the routes", () => {
	const post = async (body: unknown) => {
		const route = await import("../app/api/chats/route.ts");
		return route.POST(new Request("http://localhost/api/chats", { method: "POST", body: JSON.stringify(body) }));
	};
	const chatsOnDisk = () => stores.stores.chatStore.listChats();

	it("starts a lesson for a course from cards: the record carries both, the study marker leads", async () => {
		const res = await post({
			title: "Wrist drop",
			study: { courseId: "anat", cardIds: ["three", "two"] },
			graphContext: { propositions: [{ id: "n1", name: "Radial nerve", statement: "The radial nerve extends the wrist." }] },
		});
		const { id } = (await res.json()) as { id: string };
		const chat = stores.stores.chatStore.getChat(id)!;
		assert.equal(chat.courseId, "anat");
		assert.deepEqual(chat.cardIds, ["three", "two"]);
		assert.deepEqual(chat.messages.map((m) => (m as LhMarkerMessage).customType), ["study-context", "graph-context"]);
		const marker = chat.messages[0] as LhMarkerMessage;
		assert.match(marker.content, /\[three\] Front: Front three \| Back: Back three \| 3 lapses/);
		assert.equal(stores.stores.chatStore.listChats().find((c) => c.id === id)?.courseId, "anat", "the list carries the course");
	});

	it("starts a lesson limited to subdecks: the marker leads with them (Slice 10h)", async () => {
		stores.stores.studyStore.upsertCards([card("two", { topic: "W1" })]);
		const { id } = (await (await post({ title: "Arm", study: { courseId: "anat", topics: ["W1"] } })).json()) as { id: string };
		const marker = stores.stores.chatStore.getChat(id)!.messages[0] as LhMarkerMessage;
		assert.match(marker.content, /^Subdecks in this lesson: W1\.$/m);
		assert.deepEqual((marker.details as StudyContextData).subdecks, ["W1"]);
	});

	it("starts a lesson for a course alone", async () => {
		const { id } = (await (await post({ title: "Arm", study: { courseId: "anat" } })).json()) as { id: string };
		const chat = stores.stores.chatStore.getChat(id)!;
		assert.equal(chat.courseId, "anat");
		assert.equal(chat.cardIds, undefined);
		assert.match((chat.messages[0] as LhMarkerMessage).content, /the course this session belongs to/);
	});

	it("refuses an unknown course or card before any session exists, and ignores study on a practice session", async () => {
		assert.equal((await post({ title: "x", study: { courseId: "nope" } })).status, 404);
		assert.equal((await post({ title: "x", study: { courseId: "anat", cardIds: ["bio1"] } })).status, 404);
		assert.equal((await post({ title: "x", study: { cardIds: ["two"] } })).status, 404);
		assert.equal(chatsOnDisk().length, 0, "no orphan session");
		const { id } = (await (await post({ title: "drill", kind: "practice", study: { courseId: "anat" } })).json()) as { id: string };
		const practice = stores.stores.chatStore.getChat(id)!;
		assert.equal(practice.courseId, undefined);
		assert.equal(practice.messages.length, 0);
	});

	it("moves a lesson to another course, takes it out, and refuses an unknown course", async () => {
		const { id } = (await (await post({ title: "Loose" })).json()) as { id: string };
		const put = async (courseId: unknown) => {
			const route = await import("../app/api/chats/[id]/course/route.ts");
			return route.PUT(new Request("http://localhost/x", { method: "PUT", body: JSON.stringify({ courseId }) }), { params: Promise.resolve({ id }) });
		};
		const before = stores.stores.chatStore.getChat(id)!.updatedAt;
		assert.deepEqual(await (await put("bio")).json(), { courseId: "bio" });
		assert.equal(stores.stores.chatStore.getChat(id)!.courseId, "bio");
		assert.equal(stores.stores.chatStore.getChat(id)!.updatedAt, before, "a regrouping is not activity");
		assert.deepEqual(await (await put(null)).json(), { courseId: null });
		assert.equal("courseId" in stores.stores.chatStore.getChat(id)!, false);
		assert.equal((await put("nope")).status, 404);
		assert.equal((await put(7)).status, 400);
		const route = await import("../app/api/chats/[id]/course/route.ts");
		const missing = await route.PUT(new Request("http://localhost/x", { method: "PUT", body: "{}" }), { params: Promise.resolve({ id: "chat_missing" }) });
		assert.equal(missing.status, 404);
	});

	it("announces a regrouping to the sidebar, and a new lesson with its course in the list", async () => {
		const { subscribe } = await import("../src/core/events.ts");
		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "chats-changed") announces++;
		});
		const chat = stores.stores.chatStore.createChat("Linked", undefined, { courseId: "anat", cardIds: ["two"] });
		assert.equal(announces, 1);
		assert.equal(chat.courseId, "anat");
		assert.deepEqual(chat.cardIds, ["two"]);
		stores.stores.chatStore.setChatCourse(chat.id, "bio");
		assert.equal(announces, 2, "the course mark and filter live off this event");
		assert.throws(() => stores.stores.chatStore.setChatCourse("chat_missing", "bio"));
		assert.equal(announces, 2, "a miss writes and announces nothing");
		off();
	});

	it("serves the weak list", async () => {
		const route = await import("../app/api/study/weak/route.ts");
		const ok = await route.GET(new Request("http://localhost/api/study/weak?course=anat"));
		const body = (await ok.json()) as { courseId: string; cards: Array<{ id: string }> };
		assert.equal(body.courseId, "anat");
		assert.deepEqual(body.cards.map((c) => c.id), ["three", "two"]);
		assert.equal((await route.GET(new Request("http://localhost/api/study/weak"))).status, 400);
		assert.equal((await route.GET(new Request("http://localhost/api/study/weak?course=nope"))).status, 404);
	});
});
