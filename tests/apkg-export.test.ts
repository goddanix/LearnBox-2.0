/**
 * .apkg export tests — the pure plan (core/apkg.ts) and the package writer (server/apkg-export.ts).
 *
 * The package is read back here with a small ZIP reader and node:sqlite, so the layout is checked structurally. That it
 * really imports into Anki was checked once against Anki 26.09.3's own Python library in a throw-away collection (see
 * the Learnbox 2.0 notes); that check needs the Anki app and is not part of this suite.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { after, describe, it } from "node:test";
import { CORE_TAG, deckNameOf, guidFor, planApkg, type ApkgInput } from "../src/core/apkg.ts";
import { ALL_MODELS, BASIC_MODEL, CLOZE_MODEL, MCQ_MODEL, OCCLUSION_MODEL } from "../src/core/apkg-models.ts";
import type { StudyCard, StudyCourse, StudyReview } from "../src/core/contracts/study.ts";
import { replay } from "../src/core/fsrs.ts";
import { courseFsrsOptions, localDay } from "../src/core/study-queue.ts";
import { exportApkg, exportFileName, parseExportRequest, zipEntries } from "../src/server/apkg-export.ts";
import { StudyInputError } from "../src/server/study.ts";
import { createStudyStore, type StudyFiles } from "../src/store/study.ts";

const NOW = new Date(2026, 10, 6, 12, 0, 0);
const at = (day: number, hour = 10, minute = 0): string => new Date(2026, 10, day, hour, minute).toISOString();

const course = (over: Partial<StudyCourse> = {}): StudyCourse => ({ id: "anatomie", name: "Anatomie", bufferDays: 5, createdAt: at(1), ...over });

let seq = 0;
function card(over: Partial<StudyCard> & Pick<StudyCard, "kind" | "fields">): StudyCard {
	seq++;
	return { id: `c${seq}`, courseId: "anatomie", tags: [], core: false, origin: { kind: "manual" }, createdAt: at(1, 9, seq), ...over };
}
const basic = (over: Partial<StudyCard> = {}): StudyCard => card({ kind: "basic", fields: { Front: "Q", Back: "A", Extra: "", Source: "", Reverse: "" }, ...over });
const review = (cardId: string, day: number, grade: 1 | 2 | 3 | 4, hour = 10): StudyReview => ({ cardId, at: at(day, hour), grade, ms: 4200 });

const input = (over: Partial<ApkgInput>): ApkgInput => ({ courses: [course()], cards: [], reviews: [], options: { progress: false, subdecks: true }, now: NOW, ...over });

describe("the plan: notes, cards, decks", () => {
	it("keeps the cards of one draft in one note, with the reverse field filled", () => {
		const origin = { kind: "pdf", jobId: "j1", draftId: "d1", page: 3 } as const;
		const fields = { Front: "F", Back: "B", Extra: "", Source: "s", Reverse: "" };
		const plan = planApkg(input({ cards: [basic({ id: "crt_j1_d1_v1", fields, origin, variant: 1 }), basic({ id: "crt_j1_d1", fields, origin, variant: 0 })] }));
		assert.equal(plan.notes.length, 1);
		assert.deepEqual(plan.cards.map((c) => c.ord).sort(), [0, 1]);
		assert.equal(new Set(plan.cards.map((c) => c.nid)).size, 1);
		const reverse = BASIC_MODEL.fields.indexOf("Reverse");
		assert.equal(plan.notes[0]!.fields[reverse], "y");
		assert.equal(plan.notes[0]!.mid, BASIC_MODEL.id);
	});

	it("makes one cloze card per gap number", () => {
		const fields = { Text: "{{c1::a}} and {{c2::b}}", Extra: "", Source: "", LegendCloze: "" };
		const plan = planApkg(input({ cards: [card({ kind: "cloze", fields, variant: 0 }), card({ kind: "cloze", fields, variant: 1, origin: { kind: "manual" } })] }));
		// two manual cards are two notes (no shared draft), each with its own gap number
		assert.equal(plan.notes.length, 2);
		assert.deepEqual(plan.cards.map((c) => c.ord), [0, 1]);
		assert.ok(plan.notes.every((n) => n.mid === CLOZE_MODEL.id));
	});

	it("puts an occlusion, a multiple-choice card and a Kernwissen tag on the right note types", () => {
		const plan = planApkg(
			input({
				cards: [
					card({ kind: "occlusion", fields: { Header: "H", QuestionImage: '<img src="a.png">', AnswerImage: '<img src="b.png">', Answer: "x", Extra: "", Source: "" } }),
					card({ kind: "mcq", fields: { Question: "Q?", OptionA: "1", OptionB: "2", OptionC: "", OptionD: "", Correct: "A", Explanation: "e", Source: "" }, core: true, tags: ["Create::Doc", "has space"] }),
				],
			}),
		);
		assert.deepEqual(plan.notes.map((n) => n.mid), [OCCLUSION_MODEL.id, MCQ_MODEL.id]);
		assert.deepEqual(plan.media, ["a.png", "b.png"]);
		assert.deepEqual(plan.notes[1]!.tags, ["Create::Doc", "has_space", CORE_TAG]);
		assert.deepEqual(plan.notes[0]!.tags, []);
	});

	it("keeps an Anki-imported card's note and card ids, and folds foreign fields into Extra", () => {
		const origin = { kind: "anki-import", noteId: 1700000000123 } as const;
		const fields = { Front: "F", Back: "B", "Notes 2": "see <i>chapter 4</i>", Extra: "" };
		const plan = planApkg(input({ cards: [basic({ id: "anki_1700000000999", fields, origin, variant: 0 })] }));
		assert.equal(plan.notes[0]!.id, 1700000000123);
		assert.equal(plan.cards[0]!.id, 1700000000999);
		assert.match(plan.notes[0]!.fields[BASIC_MODEL.fields.indexOf("Extra")]!, /<b>Notes 2:<\/b> see <i>chapter 4<\/i>/);
		assert.equal(plan.summary.foldedNotes, 1);
	});

	it("never repeats an id, even for cards made in the same millisecond", () => {
		const same = at(2);
		const plan = planApkg(input({ cards: [basic({ createdAt: same }), basic({ createdAt: same }), basic({ createdAt: same })] }));
		assert.equal(new Set(plan.cards.map((c) => c.id)).size, 3);
		assert.equal(new Set(plan.notes.map((n) => n.id)).size, 3);
		assert.equal(new Set(plan.notes.map((n) => n.guid)).size, 3);
	});

	it("names decks after course and topic, and flattens them when asked", () => {
		assert.equal(deckNameOf("Anatomie", "Arm::Nerven", true), "Anatomie::Arm::Nerven");
		assert.equal(deckNameOf("Anatomie", "Arm::Nerven", false), "Anatomie");
		assert.equal(deckNameOf("  An  \"a\" ", "::x::", true), "An a::x");
		const plan = planApkg(input({ cards: [basic({ topic: "Arm" }), basic({ topic: "Bein" }), basic()] }));
		assert.deepEqual(plan.decks.map((d) => d.name).sort(), ["Anatomie", "Anatomie::Arm", "Anatomie::Bein"]);
		assert.ok(plan.decks.every((d) => d.id > 1));
		const flat = planApkg(input({ cards: [basic({ topic: "Arm" }), basic({ topic: "Bein" })], options: { progress: false, subdecks: false } }));
		assert.deepEqual(flat.decks.map((d) => d.name), ["Anatomie"]);
	});

	it("exports only the chosen courses, in the courses' order", () => {
		const plan = planApkg(
			input({
				courses: [course({ id: "b", name: "B" }), course({ id: "a", name: "A" })],
				cards: [basic({ courseId: "a" }), basic({ courseId: "b" }), basic({ courseId: "zzz" })],
			}),
		);
		assert.equal(plan.cards.length, 2);
		assert.deepEqual(plan.decks.map((d) => d.name), ["B", "A"]);
	});

	it("derives guids and ids from the data alone", () => {
		const cards = [basic({ topic: "Arm" }), basic()];
		assert.deepEqual(planApkg(input({ cards })), planApkg(input({ cards })));
		assert.equal(guidFor("x"), guidFor("x"));
		assert.notEqual(guidFor("x"), guidFor("y"));
		assert.match(guidFor("learnbox__card:c1"), /^[ -~]+$/);
	});
});

describe("the plan: progress", () => {
	const cards = [basic({ id: "p-new", core: true }), basic({ id: "p-rev" }), basic({ id: "p-learn" }), basic({ id: "p-susp", suspended: true }), basic({ id: "p-undo" })];
	const reviews: StudyReview[] = [
		review("p-rev", 1, 3),
		review("p-rev", 2, 3),
		review("p-rev", 4, 3),
		review("p-learn", 6, 3, 11),
		{ ...review("p-undo", 5, 3), at: at(5, 10, 0) },
		{ ...review("p-undo", 5, 3), at: at(5, 10, 1), undo: true },
		review("p-susp", 2, 4),
	];

	it("OFF: every card arrives as a new card, only 'suspended' is kept, no history", () => {
		const plan = planApkg(input({ cards, reviews, options: { progress: false, subdecks: true } }));
		assert.equal(plan.revlog.length, 0);
		for (const c of plan.cards) {
			assert.equal(c.type, 0);
			assert.equal(c.reps, 0);
			assert.equal(c.data, "");
			assert.equal(c.queue, c.id === plan.cards.find((x) => x.queue === -1)?.id ? -1 : 0);
		}
		assert.equal(plan.cards.filter((c) => c.queue === -1).length, 1);
		// Kernwissen is first in line
		assert.equal(plan.cards.find((c) => c.due === 1)?.nid, plan.notes[0]!.id);
	});

	it("ON: the review history, the schedule and the FSRS values come along", () => {
		const plan = planApkg(input({ cards, reviews, options: { progress: true, subdecks: true } }));
		const idOf = (cardId: string) => plan.cards[cards.findIndex((c) => c.id === cardId)]!;
		// order of plan.cards follows the notes, i.e. the input order here
		const rev = idOf("p-rev");
		const state = replay("p-rev", reviews, courseFsrsOptions(course(), localDay(NOW)))!;
		assert.equal(rev.type, 2);
		assert.equal(rev.queue, 2);
		assert.equal(rev.ivl, Math.max(1, Math.round(state.scheduledDays)));
		assert.equal(rev.reps, 3);
		assert.equal(rev.factor, 2500);
		// due is a day number relative to the collection's creation day
		const dayNumber = (day: string): number => {
			const [y, m, d] = day.split("-").map(Number) as [number, number, number];
			return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
		};
		const daysSinceCrt = dayNumber(localDay(new Date(state.due))) - dayNumber(plan.crtDay);
		assert.equal(rev.due, daysSinceCrt);
		const memory = JSON.parse(rev.data) as { s: number; d: number; dr: number };
		assert.ok(memory.s > 0 && memory.d >= 1 && memory.d <= 10);

		const learn = idOf("p-learn");
		assert.equal(learn.type, 1);
		assert.equal(learn.queue, 1);
		assert.ok(learn.due > 1_000_000_000, "learning cards are due in epoch seconds");

		assert.equal(idOf("p-susp").queue, -1);
		assert.equal(idOf("p-new").type, 0);
		assert.equal(idOf("p-new").data, "");

		// the undone review is not in the history; every other line is
		const forCard = (cardId: string) => plan.revlog.filter((r) => r.cid === idOf(cardId).id);
		assert.equal(forCard("p-rev").length, 3);
		assert.equal(forCard("p-undo").length, 0);
		assert.equal(plan.revlog.length, 3 + 1 + 1);
		assert.deepEqual(forCard("p-rev").map((r) => r.type), [0, 0, 1]);
		assert.ok(forCard("p-rev")[0]!.ivl < 0, "a first answer ends in a learning step (seconds, negative)");
		assert.equal(forCard("p-rev")[0]!.time, 4200);
		// learning answers are written in Anki's legacy three-button convention (Good = 2, Easy = 3); review answers as they are
		const learnEases = plan.revlog.filter((r) => r.type !== 1).map((r) => r.ease);
		assert.ok(learnEases.every((e) => e >= 1 && e <= 3));
		assert.deepEqual(forCard("p-rev").map((r) => r.ease), [2, 2, 3]);
		assert.equal(new Set(plan.revlog.map((r) => r.id)).size, plan.revlog.length);
	});

	it("writes Again/Good/Easy of a learning step as 1/2/3 and keeps a review answer's grade", () => {
		const one = [basic({ id: "e1" }), basic({ id: "e2" }), basic({ id: "e3" })];
		const plan = planApkg(input({ cards: one, reviews: [review("e1", 5, 1), review("e2", 5, 3), review("e3", 5, 4)], options: { progress: true, subdecks: true } }));
		assert.deepEqual(plan.revlog.map((r) => r.ease), [1, 2, 3]);
		assert.ok(plan.revlog.every((r) => r.type === 0));
	});

	it("starts the collection before every due day, so no day number is negative", () => {
		const plan = planApkg(input({ cards, reviews, options: { progress: true, subdecks: true } }));
		for (const c of plan.cards) if (c.queue === 2) assert.ok(c.due >= 1);
		assert.ok(plan.crtDay < "2026-11-01");
		assert.equal(new Date(plan.crt * 1000).getHours(), 4);
	});
});

// ─── the package ────────────────────────────────────────────────────────────

interface ZipFile {
	name: string;
	data: Buffer;
	method: number;
}

/** A small ZIP reader (central directory), checking each CRC. */
function readZip(zip: Buffer): ZipFile[] {
	const end = zip.length - 22;
	assert.equal(zip.readUInt32LE(end), 0x06054b50, "end of central directory");
	const count = zip.readUInt16LE(end + 10);
	let at = zip.readUInt32LE(end + 16);
	const out: ZipFile[] = [];
	for (let i = 0; i < count; i++) {
		assert.equal(zip.readUInt32LE(at), 0x02014b50);
		const method = zip.readUInt16LE(at + 10);
		const crc = zip.readUInt32LE(at + 16);
		const csize = zip.readUInt32LE(at + 20);
		const usize = zip.readUInt32LE(at + 24);
		const nameLen = zip.readUInt16LE(at + 28);
		const local = zip.readUInt32LE(at + 42);
		const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf-8");
		assert.equal(zip.readUInt32LE(local), 0x04034b50);
		const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		const body = zip.subarray(start, start + csize);
		const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
		assert.equal(data.length, usize);
		assert.equal(zlib.crc32(data) >>> 0, crc, `crc of ${name}`);
		out.push({ name, data, method });
		at += 46 + nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
	}
	return out;
}

const tmp: string[] = [];
const scratch = (): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apkg-test-"));
	tmp.push(dir);
	return dir;
};
after(() => {
	for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

function deps() {
	const dir = scratch();
	const files: StudyFiles = { courses: path.join(dir, "courses.jsonl"), cards: path.join(dir, "cards.jsonl"), reviews: path.join(dir, "reviews.jsonl") };
	const store = createStudyStore(files);
	const mediaDir = path.join(dir, "media");
	fs.mkdirSync(mediaDir);
	return { store, mediaDir, dir };
}

describe("the package", () => {
	it("is a ZIP with collection.anki2, a media map and the numbered media files", () => {
		const d = deps();
		d.store.upsertCourse(course());
		fs.writeFileSync(path.join(d.mediaDir, "arm.png"), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
		d.store.upsertCards([
			basic({ fields: { Front: 'see <img src="arm.png"> and <img src="gone.png">', Back: "B", Extra: "", Source: "", Reverse: "y" }, origin: { kind: "pdf", jobId: "j", draftId: "x" }, variant: 0, id: "crt_j_x" }),
			basic({ fields: { Front: 'see <img src="arm.png"> and <img src="gone.png">', Back: "B", Extra: "", Source: "", Reverse: "y" }, origin: { kind: "pdf", jobId: "j", draftId: "x" }, variant: 1, id: "crt_j_x_v1" }),
			basic({ topic: "Arm", core: true }),
		]);
		const result = exportApkg({ courseIds: ["anatomie"], progress: false, subdecks: true }, NOW, { store: d.store, mediaDir: d.mediaDir });
		assert.equal(result.filename, "Learnbox-Anatomie-2026-11-06.apkg");
		assert.deepEqual({ notes: result.summary.notes, cards: result.summary.cards, media: result.summary.media, missing: result.summary.missingMedia }, { notes: 2, cards: 3, media: 1, missing: ["gone.png"] });

		const files = readZip(result.bytes);
		assert.deepEqual(files.map((f) => f.name), ["collection.anki2", "media", "0"]);
		assert.deepEqual(JSON.parse(files[1]!.data.toString()), { "0": "arm.png" });
		assert.deepEqual([...files[2]!.data], [137, 80, 78, 71, 1, 2, 3]);
		assert.equal(files[2]!.method, 0, "media are stored, not deflated");

		// the collection opens and holds what the plan said
		fs.writeFileSync(path.join(d.dir, "col.anki2"), files[0]!.data);
		const col = new (process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")).DatabaseSync(path.join(d.dir, "col.anki2"), { readOnly: true });
		const count = (sql: string): number => (col.prepare(sql).get() as { n: number }).n;
		assert.equal(count("select count(*) n from notes"), 2);
		assert.equal(count("select count(*) n from cards"), 3);
		assert.equal(count("select count(*) n from revlog"), 0);
		const row = col.prepare("select ver, crt, conf, models, decks from col").get() as { ver: number; crt: number; conf: string; models: string; decks: string };
		assert.equal(row.ver, 11);
		const models = JSON.parse(row.models) as Record<string, { name: string; flds: unknown[]; tmpls: unknown[]; req: unknown[] }>;
		assert.deepEqual(Object.values(models).map((m) => m.name), ALL_MODELS.map((m) => m.name));
		assert.deepEqual(Object.keys(JSON.parse(row.decks) as object).length, 3, "Default + Anatomie + Anatomie::Arm");
		const note = col.prepare("select flds, tags from notes order by id limit 1").get() as { flds: string; tags: string };
		assert.equal(note.flds.split("\u001f").length, BASIC_MODEL.fields.length);
		const tagged = col.prepare("select tags from notes where tags like ?").get(`% ${CORE_TAG} %`) as { tags: string } | undefined;
		assert.ok(tagged, "the core card carries the Kernwissen tag, space padded");
		col.close();
	});

	it("writes the review history when the progress is taken along", () => {
		const d = deps();
		d.store.upsertCourse(course());
		const c = basic({ id: "r1" });
		d.store.upsertCard(c);
		d.store.appendReviews([review("r1", 1, 3), review("r1", 3, 2)]);
		const result = exportApkg({ courseIds: ["anatomie"], progress: true }, NOW, { store: d.store, mediaDir: d.mediaDir });
		assert.equal(result.summary.reviews, 2);
		const file = readZip(result.bytes)[0]!;
		fs.writeFileSync(path.join(d.dir, "p.anki2"), file.data);
		const col = new (process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")).DatabaseSync(path.join(d.dir, "p.anki2"), { readOnly: true });
		const log = col.prepare("select ease, type from revlog order by id").all() as { ease: number; type: number }[];
		assert.deepEqual(log.map((r) => r.ease), [2, 2]); // learning answers: legacy convention (Good = 2)
		const cardRow = col.prepare("select type, queue, reps from cards").get() as { type: number; queue: number; reps: number };
		assert.equal(cardRow.reps, 2);
		assert.ok(cardRow.type >= 1);
		col.close();
	});

	it("refuses bad requests", () => {
		const d = deps();
		d.store.upsertCourse(course());
		const run = (body: unknown) => exportApkg(body, NOW, { store: d.store, mediaDir: d.mediaDir });
		assert.throws(() => run({}), (e) => e instanceof StudyInputError && e.status === 400);
		assert.throws(() => run({ courseIds: [] }), StudyInputError);
		assert.throws(() => run({ courseIds: ["nope"] }), (e) => e instanceof StudyInputError && e.status === 404);
		assert.throws(() => run({ courseIds: ["anatomie"], progress: "yes" }), StudyInputError);
		assert.throws(() => run({ courseIds: ["anatomie"] }), /no cards/);
		assert.deepEqual(parseExportRequest({ courseIds: ["b", "a"], progress: true }, ["a", "b", "c"]), { courseIds: ["a", "b"], progress: true, subdecks: true });
	});

	it("names the file after the course, safely", () => {
		assert.equal(exportFileName(["Medizinische Biologie"], NOW), "Learnbox-Medizinische-Biologie-2026-11-06.apkg");
		assert.equal(exportFileName(["../../etc/passwd"], NOW), "Learnbox-etc-passwd-2026-11-06.apkg");
		assert.equal(exportFileName(["a", "b", "c"], NOW), "Learnbox-3-courses-2026-11-06.apkg");
		assert.equal(exportFileName(["???"], NOW), "Learnbox-export-2026-11-06.apkg");
	});

	it("packs entries the way ZIP readers expect", () => {
		const zip = zipEntries([
			{ name: "a.txt", data: Buffer.from("hello ".repeat(100)), deflate: true },
			{ name: "empty", data: Buffer.alloc(0), deflate: true },
			{ name: "b.bin", data: Buffer.from([1, 2, 3]), deflate: false },
		], NOW);
		const files = readZip(zip);
		assert.deepEqual(files.map((f) => f.name), ["a.txt", "empty", "b.bin"]);
		assert.equal(files[0]!.method, 8);
		assert.equal(files[0]!.data.toString(), "hello ".repeat(100));
		assert.equal(files[1]!.data.length, 0);
	});
});
