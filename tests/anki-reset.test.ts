/**
 * Starting the Anki cards over (src/server/anki-reset.ts, scripts/anki-reset-import.ts): scratch folders only, the
 * Anki fixture as the collection. The real data folder is never named here.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { suggestPlan } from "../src/core/anki-import.ts";
import type { StudyCard, StudyCourse, StudyReview } from "../src/core/contracts/study.ts";
import { runAnkiImport } from "../src/server/anki-import.ts";
import {
	ResetUsageError,
	appIsRunning,
	applyAnkiReset,
	formatReport,
	parseResetArgs,
	parseRule,
	planAnkiReset,
	retargetFor,
	runResetImport,
	type ResetImportOptions,
} from "../src/server/anki-reset.ts";
import { readAnkiCollection } from "../src/store/anki-source.ts";
import { createStudyStore, type StudyFiles } from "../src/store/study.ts";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "anki", "collection.anki2");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "anki-reset-"));
after(() => {
	fs.chmodSync(root, 0o700);
	fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
const scratch = (): string => {
	const dir = path.join(root, `d${++n}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
};
const filesIn = (dataDir: string): StudyFiles => ({
	courses: path.join(dataDir, "study", "courses.jsonl"),
	cards: path.join(dataDir, "study", "cards.jsonl"),
	reviews: path.join(dataDir, "study", "reviews.jsonl"),
});
const read = (f: string) => fs.readFileSync(f, "utf-8");
const NOW = new Date("2026-11-06T09:00:00Z");

const manualCard = (id: string, courseId: string): StudyCard => ({
	id,
	courseId,
	kind: "basic",
	fields: { Front: `front ${id}`, Back: "back" },
	tags: [],
	core: false,
	origin: { kind: "manual" },
	createdAt: "2026-10-01T00:00:00.000Z",
});
const review = (cardId: string, at: string, grade: StudyReview["grade"] = 3): StudyReview => ({ cardId, at, grade });

/**
 * A data folder as the first Anki import left it (top deck = course), plus things that must survive:
 * a hand-made card with a review in the imported course "physiologie", a hand-made course of its own,
 * two reviews made in Learnbox only (on an imported card, and on the Czech card the new plan leaves out), and with
 * `torn` a torn last line in the cards ledger.
 */
function seed(torn = false): { dataDir: string; files: StudyFiles; manualLine: string; ankiId: string } {
	const dataDir = scratch();
	const files = filesIn(dataDir);
	const store = createStudyStore(files);
	const first = suggestPlan(readAnkiCollection(FIXTURE), NOW); // level 0
	runAnkiImport(FIXTURE, first, { store, mediaDest: path.join(dataDir, "study", "media") });
	const course = (id: string, name: string, extra: Partial<StudyCourse> = {}): StudyCourse => ({
		id,
		name,
		bufferDays: 5,
		createdAt: "2026-10-01T00:00:00.000Z",
		...extra,
	});
	store.upsertCourse(course("eigene", "Eigene"));
	store.upsertCards([manualCard("m1", "eigene"), manualCard("m2", "physiologie")]);
	store.appendReviews([review("m1", "2026-11-01T10:00:00.000Z"), review("m2", "2026-11-02T10:00:00.000Z")]);
	// the Czech course is skipped by the new plan and carries a topic setting, so the reset keeps it
	const czech = store.readCourses().find((c) => c.id === "tschechisch")!;
	store.upsertCourse({ ...czech, topics: ["Verben"] });
	const anki = store.readCards().find((c) => c.origin.kind === "anki-import" && c.courseId === "anatomie")!;
	store.appendReview(review(anki.id, "2026-11-03T10:00:00.000Z", 1)); // Learnbox only: Anki never saw it
	const czechCard = store.readCards().find((c) => c.courseId === "tschechisch")!;
	store.appendReview(review(czechCard.id, "2026-11-03T11:00:00.000Z", 2));
	if (torn) fs.appendFileSync(files.cards, "{ torn line without end");
	const manualLine = read(files.cards)
		.split("\n")
		.find((l) => l.includes('"id":"m1"'))!;
	return { dataDir, files, manualLine, ankiId: anki.id };
}

const options = (dataDir: string, over: Partial<ResetImportOptions> = {}): ResetImportOptions => ({
	dataDir,
	collection: FIXTURE,
	subjectLevel: 1,
	rules: [parseRule("skip", "Tschechisch"), parseRule("merge", "Anatomie::Arm=Anatomie")],
	apply: false,
	backupDir: path.join(scratch(), "backup", "study"),
	now: NOW,
	...over,
});

describe("rules from the command line", () => {
	it("parses a skip and a merge, keeps the levels, refuses empty names", () => {
		assert.deepEqual(parseRule("skip", "Tests"), { prefix: ["Tests"], course: null });
		assert.deepEqual(parseRule("skip", "1st Year :: Tests"), { prefix: ["1st Year", "Tests"], course: null });
		assert.deepEqual(parseRule("merge", "A::Muscles Origin-Insertion=Anatomy"), {
			prefix: ["A", "Muscles Origin-Insertion"],
			course: "Anatomy",
		});
		assert.throws(() => parseRule("merge", "A::B"), /expected/);
		assert.throws(() => parseRule("merge", "A::B="), /empty/);
		assert.throws(() => parseRule("skip", "A::::B"), /empty/);
	});

	it("retargets by whole levels: skip leaves out, merge keeps the rest as the topic, other decks stay as placed", () => {
		const { retarget, hits } = retargetFor([parseRule("skip", "Tests"), parseRule("merge", "Y::Anatomy::Muscles=Anatomy")]);
		const placed = { course: "x" };
		assert.equal(retarget(["Tests", "Müll"], placed), null);
		assert.deepEqual(retarget(["Y", "Anatomy", "Muscles", "1 Upper limb"], placed), { course: "Anatomy", topic: "1 Upper limb" });
		assert.deepEqual(retarget(["Y", "Anatomy", "Muscles"], placed), { course: "Anatomy" }, "the prefix itself has no topic");
		assert.equal(retarget(["Y", "Anatomy", "MusclesX", "1"], placed), placed, "a prefix is whole levels, not text");
		assert.equal(retarget(["Y", "Biology", "W1"], placed), placed);
		assert.deepEqual(hits, [1, 2]);
	});
});

describe("planAnkiReset / applyAnkiReset", () => {
	it("finds the Anki cards and courses that held nothing else; changes nothing", () => {
		const { files } = seed();
		const before = [files.courses, files.cards, files.reviews].map(read);
		const plan = planAnkiReset(files);
		assert.deepEqual([files.courses, files.cards, files.reviews].map(read), before);

		assert.equal(plan.ankiCards.length, 7);
		assert.ok(plan.ankiCards.every((c) => c.origin.kind === "anki-import"));
		assert.equal(plan.keptCards, 2, "the two hand-made cards");
		assert.equal(plan.keptReviews, 2);
		assert.equal(plan.ankiReviews.length, 9, "7 from Anki + 2 made in Learnbox");
		assert.deepEqual(plan.dropCourses.map((c) => c.id).sort(), ["anatomie"], "physiologie has a hand-made card, tschechisch has topics");
		assert.deepEqual(plan.keptCourses.map((k) => [k.course.id, k.why]), [["tschechisch", "has topics set"]]);
	});

	it("backs up first, removes only the Anki lines, keeps every other line byte for byte (a torn one too)", () => {
		const { files, manualLine, ankiId } = seed(true);
		const backup = path.join(scratch(), "bk");
		const was = { courses: read(files.courses), cards: read(files.cards), reviews: read(files.reviews) };

		applyAnkiReset(files, backup);

		for (const k of ["courses", "cards", "reviews"] as const) assert.equal(read(path.join(backup, `${k}.jsonl`)), was[k], `${k} backup`);
		const cards = read(files.cards);
		assert.ok(cards.includes(manualLine), "the hand-made card's line is untouched");
		assert.ok(cards.includes("{ torn line without end\n"), "the torn line stays, now closed by a line break");
		assert.ok(!cards.includes("anki_"), "no Anki card line is left");
		const store = createStudyStore(files);
		assert.deepEqual(store.readCards().map((c) => c.id).sort(), ["m1", "m2"]);
		assert.deepEqual(store.readReviews().map((r) => r.cardId).sort(), ["m1", "m2"]);
		assert.ok(!read(files.reviews).includes(ankiId));
		assert.deepEqual(store.readCourses().map((c) => c.id).sort(), ["eigene", "physiologie", "tschechisch"]);
	});

	it("refuses a backup folder that is not empty and then changes nothing", () => {
		const { files } = seed();
		const backup = scratch();
		fs.writeFileSync(path.join(backup, "something"), "x");
		const was = [files.courses, files.cards, files.reviews].map(read);
		assert.throws(() => applyAnkiReset(files, backup), /not empty/);
		assert.deepEqual([files.courses, files.cards, files.reviews].map(read), was);
	});

	it("puts the earlier ledgers back when one of the writes fails", { skip: process.getuid?.() === 0 }, () => {
		const { files } = seed();
		// the courses ledger lives in a folder that cannot take a new file, so its (third) write fails
		const lockedDir = scratch();
		const courses = path.join(lockedDir, "courses.jsonl");
		fs.copyFileSync(files.courses, courses);
		fs.chmodSync(lockedDir, 0o500);
		const split: StudyFiles = { ...files, courses };
		const was = [files.cards, files.reviews, courses].map(read);
		try {
			assert.throws(() => applyAnkiReset(split, path.join(scratch(), "bk")));
		} finally {
			fs.chmodSync(lockedDir, 0o700);
		}
		assert.deepEqual([files.cards, files.reviews, courses].map(read), was, "cards and reviews are back as they were");
	});
});

describe("appIsRunning", () => {
	it("sees Electron's SingletonLock of a live process, ignores a dead one and a missing one", () => {
		const app = scratch();
		const data = path.join(app, "data");
		fs.mkdirSync(data);
		assert.equal(appIsRunning(data), false, "no lock");
		fs.symlinkSync(`Some-Mac.local-${process.pid}`, path.join(app, "SingletonLock"));
		assert.equal(appIsRunning(data), true, "this very process is alive");
		fs.rmSync(path.join(app, "SingletonLock"));
		fs.symlinkSync("Some-Mac.local-2147483000", path.join(app, "SingletonLock"));
		assert.equal(appIsRunning(data), false, "a stale lock of a dead process");
	});
});

describe("runResetImport", () => {
	it("a dry run shows the new structure and what is lost, and changes nothing", () => {
		const { dataDir, files } = seed();
		const before = [files.courses, files.cards, files.reviews].map((f) => [read(f), fs.statSync(f).mtimeMs]);
		const o = options(dataDir);
		const r = runResetImport(o);

		assert.equal(r.applied, false);
		assert.deepEqual(
			r.courses.map((c) => [c.name, c.cards, c.noTopic, c.topics]),
			[
				["Anatomie", 4, 2, [{ name: "Nerven", cards: 2 }]],
				["Physiologie", 2, 2, []],
			],
			"the Arm tree is merged into Anatomie (topic Nerven); Tschechisch is left out",
		);
		assert.deepEqual(r.skippedDecks, [{ name: "Tschechisch", cards: 1 }]);
		assert.equal(r.import.cards, 6);
		assert.deepEqual(r.reset.dropCourses, ["Anatomie"]);
		assert.equal(r.reset.cards, 7);
		assert.equal(r.reset.keptCards, 2);
		assert.equal(r.lost.reviewsOnlyInLearnbox, 1, "the one review made in Learnbox on a card that is re-imported");
		assert.equal(r.lost.reviewsOfLeftOutCards, 1, "the Czech card's review");
		assert.equal(r.lost.cardsGoneFromAnki, 1, "the Czech card");
		assert.deepEqual(r.lost.changedCards, { fields: 0, tags: 0, core: 0, kind: 0, suspended: 0 });
		assert.ok(r.hints.some((h) => h.startsWith("Physiologie:") && h.includes("already exists")));

		assert.deepEqual([files.courses, files.cards, files.reviews].map((f) => [read(f), fs.statSync(f).mtimeMs]), before);
		assert.equal(fs.existsSync(o.backupDir), false, "no backup folder for a dry run");
		const text = formatReport(r);
		assert.match(text, /^DRY RUN/);
		assert.match(text, /Anatomie.*4 cards\n +\(no topic\) {2}2\n +Nerven {2}2/);
	});

	it("notices a card the owner changed locally", () => {
		const { dataDir, files } = seed();
		const store = createStudyStore(files);
		const c = store.readCards().find((x) => x.origin.kind === "anki-import" && x.courseId === "physiologie")!;
		store.upsertCard({ ...c, fields: { ...c.fields, Front: "edited here" } });
		const r = runResetImport(options(dataDir));
		assert.equal(r.lost.changedCards.fields, 1);
	});

	it("a rule that matches no deck is a typo and stops the run", () => {
		const { dataDir } = seed();
		assert.throws(() => runResetImport(options(dataDir, { rules: [parseRule("skip", "Tschechish")] })), /no deck matches: Tschechish/);
	});

	it("applies: backup, reset, import; the new structure is in the ledgers and what stayed is untouched", () => {
		const { dataDir, files, manualLine } = seed(true);
		const o = options(dataDir, { apply: true });
		const r = runResetImport(o);

		assert.equal(r.applied, true);
		assert.equal(r.backupDir, o.backupDir);
		assert.ok(fs.existsSync(path.join(o.backupDir, "cards.jsonl")));
		const store = createStudyStore(files);
		const cards = store.readCards();
		assert.equal(cards.length, 6 + 2, "re-imported cards + the two hand-made ones");
		assert.ok(read(files.cards).includes(manualLine));
		const topicOf = (courseId: string) => cards.filter((c) => c.courseId === courseId && c.origin.kind === "anki-import").map((c) => c.topic ?? "");
		assert.deepEqual(topicOf("anatomie").sort(), ["", "", "Nerven", "Nerven"]);
		assert.equal(topicOf("physiologie").length, 2);
		assert.equal(topicOf("tschechisch").length, 0, "the skipped deck's card is gone");
		assert.deepEqual(store.readCourses().map((c) => c.id).sort(), ["anatomie", "eigene", "physiologie", "tschechisch"]);
		assert.equal(store.readReviews().filter((x) => x.cardId.startsWith("anki_")).length, r.import.reviews);
		assert.equal(store.readReviews().filter((x) => x.cardId.startsWith("m")).length, 2, "hand-made cards keep their reviews");
		assert.match(formatReport(r), /^DONE/);
	});

	it("a second run gives the same cards and reviews again (nothing doubles)", () => {
		const { dataDir, files } = seed();
		runResetImport(options(dataDir, { apply: true }));
		const store = createStudyStore(files);
		const key = () => JSON.stringify([store.readCards().map((c) => c.id).sort(), store.readReviews().length, store.readCourses().map((c) => c.id).sort()]);
		const first = key();
		runResetImport(options(dataDir, { apply: true }));
		assert.equal(key(), first);
	});

	it("refuses to apply while the desktop app is running on the data folder", () => {
		const app = scratch();
		const dataDir = path.join(app, "data");
		fs.mkdirSync(path.join(dataDir, "study"), { recursive: true });
		fs.symlinkSync(`Some-Mac.local-${process.pid}`, path.join(app, "SingletonLock"));
		assert.throws(() => runResetImport(options(dataDir, { apply: true })), /running/);
		assert.equal(fs.existsSync(path.join(dataDir, "study", "cards.jsonl")), false);
	});

	it("refuses a missing data folder and a file that is no collection", () => {
		assert.throws(() => runResetImport(options(path.join(scratch(), "nope"))), /data folder not found/);
		const { dataDir } = seed();
		assert.throws(() => runResetImport(options(dataDir, { collection: path.join(dataDir, "study", "cards.jsonl") })), /not an Anki collection/);
	});
});

describe("parseResetArgs / the program", () => {
	it("defaults to a look (no --apply), level 1, and a backup folder beside the data folder", () => {
		const o = parseResetArgs(["--data-dir", "/x/Learnbox/data", "--collection", "/a/c.anki2"], new Date("2026-11-06T10:49:05Z"));
		assert.equal(o.apply, false);
		assert.equal(o.subjectLevel, 1);
		assert.deepEqual(o.rules, []);
		assert.equal(o.backupDir, "/x/Learnbox/data-backup-vor-neuimport-20261106-104905/study");
	});

	it("takes repeated --skip and --merge, --subject-level, --backup-dir and --apply", () => {
		const o = parseResetArgs(
			["--data-dir", "/d", "--collection", "/c.anki2", "--skip", "Tests", "--merge", "A::M=Anatomy", "--subject-level", "2", "--backup-dir", "/b", "--apply"],
			NOW,
		);
		assert.equal(o.apply, true);
		assert.equal(o.subjectLevel, 2);
		assert.equal(o.backupDir, "/b");
		assert.deepEqual(o.rules, [parseRule("skip", "Tests"), parseRule("merge", "A::M=Anatomy")]);
	});

	it("refuses missing required options, unknown options and bad values", () => {
		assert.throws(() => parseResetArgs(["--collection", "/c.anki2"]), ResetUsageError);
		assert.throws(() => parseResetArgs(["--data-dir", "/d"]), ResetUsageError);
		assert.throws(() => parseResetArgs(["--data-dir", "/d", "--collection", "/c.anki2", "--wipe", "1"]), /unknown option/);
		assert.throws(() => parseResetArgs(["--data-dir", "/d", "--collection"]), /needs a value/);
		assert.throws(() => parseResetArgs(["--data-dir", "/d", "--collection", "/c.anki2", "--subject-level", "one"]), /whole number/);
		assert.throws(() => parseResetArgs(["--data-dir", "/d", "--collection", "/c.anki2", "--merge", "no-equals"]), ResetUsageError);
	});

	it("runs as a program: a look prints the structure, a usage error exits 2 and writes nothing", () => {
		const { dataDir, files } = seed();
		const was = read(files.cards);
		const run = (args: string[]) =>
			spawnSync(process.execPath, ["--import", "tsx", "scripts/anki-reset-import.ts", ...args], { encoding: "utf-8", env: { ...process.env, NODE_ENV: "test" } });
		const look = run(["--data-dir", dataDir, "--collection", FIXTURE, "--skip", "Tschechisch", "--merge", "Anatomie::Arm=Anatomie"]);
		assert.equal(look.status, 0, look.stderr);
		assert.match(look.stdout, /^DRY RUN/);
		assert.match(look.stdout, /Anatomie.*4 cards/);
		assert.equal(read(files.cards), was);
		const bad = run(["--data-dir", dataDir]);
		assert.equal(bad.status, 2);
		assert.match(bad.stderr, /--collection is required/);
	});
});
