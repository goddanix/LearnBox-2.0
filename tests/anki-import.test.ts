/**
 * Anki import tests — the pure mapping (core/anki-import.ts), the SQLite
 * reader + media copy (store/anki-source.ts) and the wiring
 * (server/anki-import.ts).
 *
 * The fixture tests/fixtures/anki/collection.anki2 is a REAL Anki 26.09.3
 * collection (schema 18) built in a throw-away folder with Anki's own
 * Python library — never a copy of anyone's profile. Its content: deck
 * Anatomie::Arm::Nerven (a MedAnki Basic note with a reverse card), deck
 * Anatomie (a MedAnki Bildcloze note, 2 clozes, image arm.png), deck
 * Physiologie (a MedAnki Basic card sitting in a filtered deck + a stock
 * Cloze), deck Tschechisch (a foreign note type, suspended, sound dum.mp3),
 * 8 revlog lines (one of them a type-4 reschedule), unused.png in the media.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	deckDisplayName,
	inspectCollection,
	isClozeConfig,
	mapCollection,
	mapNoteType,
	ImportPlanError,
	mediaRefs,
	parseImportPlan,
	parseSchedulerDeadlines,
	placeDeck,
	suggestPlan,
	type AnkiCollection,
	type AnkiNoteTypeRow,
} from "../src/core/anki-import.ts";
import { replay } from "../src/core/fsrs.ts";
import { copyAnkiMedia, findAnkiCollections, readAnkiCollection, stripUnicase } from "../src/store/anki-source.ts";
import { inspectAnki, listAnkiCollections, runAnkiImport } from "../src/server/anki-import.ts";
import { StudyInputError } from "../src/server/study.ts";
import { createStudyStore, type StudyFiles } from "../src/store/study.ts";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "anki", "collection.anki2");
const MEDIA = path.resolve(import.meta.dirname, "fixtures", "anki", "collection.media");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anki-import-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
	const dir = path.join(root, `case${++n}`);
	const files: StudyFiles = {
		courses: path.join(dir, "courses.jsonl"),
		cards: path.join(dir, "cards.jsonl"),
		reviews: path.join(dir, "reviews.jsonl"),
	};
	return { store: createStudyStore(files), mediaDest: path.join(dir, "media") };
};

const noteType = (over: Partial<AnkiNoteTypeRow>): AnkiNoteTypeRow => ({
	id: 1,
	name: "X",
	isCloze: false,
	fields: ["A", "B"],
	...over,
});

describe("anki-import pure helpers", () => {
	it("reads the cloze kind from the notetype protobuf", () => {
		assert.equal(isClozeConfig(Uint8Array.from([0x08, 0x01, 0x1a, 0x03, 1, 2, 3])), true);
		assert.equal(isClozeConfig(Uint8Array.from([0x1a, 0x03, 1, 2, 3])), false);
		assert.equal(isClozeConfig(Uint8Array.from([0x08, 0x00])), false);
		assert.equal(isClozeConfig(new Uint8Array()), false);
		assert.equal(isClozeConfig(Uint8Array.from([0x08])), false);
	});

	it("shows deck names with ::", () => {
		assert.equal(deckDisplayName("Anatomie\u001fArm\u001fNerven"), "Anatomie::Arm::Nerven");
	});

	it("maps note types by structure; MedAnki types stay 1:1", () => {
		assert.deepEqual(mapNoteType(noteType({ name: "MedAnki Cloze", fields: ["Text", "Extra", "Source", "LegendCloze"] })), {
			kind: "cloze",
			remapped: false,
			fieldNames: ["Text", "Extra", "Source", "LegendCloze"],
		});
		assert.deepEqual(mapNoteType(noteType({ fields: ["Wort", "Bedeutung", "Beispiel"] })), {
			kind: "basic",
			remapped: true,
			fieldNames: ["Front", "Back", "Beispiel"],
		});
		assert.deepEqual(mapNoteType(noteType({ isCloze: true, fields: ["Text", "Back Extra"] })), {
			kind: "cloze",
			remapped: true,
			fieldNames: ["Text", "Extra"],
		});
		assert.equal(mapNoteType(noteType({ isCloze: true, fields: ["Occlusion", "Image", "Header"] })), "native-image-occlusion");
		assert.equal(mapNoteType(noteType({ fields: ["Only"] })), "too-few-fields");
		// a field already called "Back" later on must not collide
		const m = mapNoteType(noteType({ fields: ["Q", "A", "Back"] }));
		assert.ok(typeof m !== "string");
		assert.deepEqual(new Set(m.fieldNames).size, 3);
	});

	it("finds images and sounds, decodes names, ignores remote URLs and paths", () => {
		const refs = mediaRefs({
			Text: '<img src="arm.png"><img src=\'a%20b.jpg\'> <img src=x.gif> <img src="https://e.com/y.png">',
			Extra: "Hör [sound:dum.mp3] und [sound:../evil.mp3]",
		});
		assert.deepEqual(refs.sort(), ["a b.jpg", "arm.png", "dum.mp3", "x.gif"]);
	});

	it("skips unmapped decks, missing notes, unsupported types, cram/manual and bad-ease lines", () => {
		const col: AnkiCollection = {
			decks: [{ id: 10, name: "D" }, { id: 11, name: "E" }],
			noteTypes: [noteType({ id: 1, name: "Basic", fields: ["Front", "Back"] }), noteType({ id: 2, name: "Image Occlusion", isCloze: true, fields: ["Occlusion", "Image"] })],
			notes: [
				{ id: 100, mid: 1, tags: " a ", flds: "q\u001fa" },
				{ id: 101, mid: 2, tags: "", flds: "o\u001fi" },
			],
			cards: [
				{ id: 1, nid: 100, did: 10, ord: 0, queue: 0, odid: 0 },
				{ id: 2, nid: 100, did: 11, ord: 1, queue: 0, odid: 0 },
				{ id: 3, nid: 999, did: 10, ord: 0, queue: 0, odid: 0 },
				{ id: 4, nid: 101, did: 10, ord: 0, queue: 0, odid: 0 },
			],
			revlog: [
				{ id: 1000, cid: 1, ease: 3, type: 0, time: 1200 },
				{ id: 2000, cid: 1, ease: 3, type: 3, time: 0 },
				{ id: 3000, cid: 1, ease: 3, type: 4, time: 0 },
				{ id: 4000, cid: 1, ease: 0, type: 1, time: 0 },
				{ id: 5000, cid: 2, ease: 3, type: 1, time: 0 },
			],
		};
		const r = mapCollection(col, { courses: [], decks: { "10": { courseId: "c" }, "11": null } });
		assert.deepEqual(r.cards.map((c) => c.id), ["anki_1"]);
		assert.deepEqual(r.report.skippedCards, { unmappedDeck: 1, noteMissing: 1, unsupportedNoteType: { "Image Occlusion": 1 } });
		assert.deepEqual(r.report.skippedReviews, { cramOrManual: 2, badEase: 1, cardNotImported: 1 });
		assert.deepEqual(r.reviews, [{ cardId: "anki_1", at: new Date(1000).toISOString(), grade: 3, ms: 1200 }]);
	});

	it("a filtered-deck card belongs to its ORIGINAL deck", () => {
		const col: AnkiCollection = {
			decks: [{ id: 10, name: "Home" }, { id: 99, name: "Filter" }],
			noteTypes: [noteType({ id: 1, name: "Basic", fields: ["Front", "Back"] })],
			notes: [{ id: 100, mid: 1, tags: "", flds: "q\u001fa" }],
			cards: [{ id: 1, nid: 100, did: 99, ord: 0, queue: 0, odid: 10 }],
			revlog: [],
		};
		assert.deepEqual(inspectCollection(col).decks.map((d) => d.name), ["Home"]);
		const r = mapCollection(col, { courses: [], decks: { "10": { courseId: "c" } } });
		assert.equal(r.cards.length, 1);
	});
});

describe("anki-import against a real Anki collection", () => {
	it("reads the schema-18 tables from a copy and leaves the original untouched", () => {
		const before = fs.readdirSync(path.dirname(FIXTURE)).sort();
		const stat = fs.statSync(FIXTURE);
		const col = readAnkiCollection(FIXTURE);
		assert.equal(col.cards.length, 7);
		assert.equal(col.revlog.length, 8);
		assert.ok(col.noteTypes.find((t) => t.name === "MedAnki Cloze")?.isCloze);
		assert.ok(!col.noteTypes.find((t) => t.name === "MedAnki Basic")?.isCloze);
		assert.deepEqual(fs.readdirSync(path.dirname(FIXTURE)).sort(), before);
		const after_ = fs.statSync(FIXTURE);
		assert.equal(after_.mtimeMs, stat.mtimeMs);
		assert.equal(after_.size, stat.size);
	});

	it("strips Anki's custom collation from the copy: newer SQLite builds cannot plan queries on `fields` with it", () => {
		// Electron 44's SQLite (3.53) fails every query on `fields` with "no query solution" while the
		// collation Anki registers itself ("unicase") is missing; the dev Node's older SQLite does not,
		// so this checks the cure (the declaration is gone, the rows are the same), not the symptom.
		const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
		const copy = path.join(root, "strip.anki2");
		fs.copyFileSync(FIXTURE, copy);
		const sqlOf = (db: InstanceType<typeof DatabaseSync>) =>
			(db.prepare("select group_concat(sql, ' ') s from sqlite_master").get() as { s: string }).s;
		const rows = "select ntid, ord, name from fields order by ntid, ord";
		const db = new DatabaseSync(copy);
		assert.match(sqlOf(db), /unicase/i);
		const before = db.prepare(rows).all();
		assert.ok(before.length > 0);
		stripUnicase(db);
		db.close();
		const patched = new DatabaseSync(copy, { readOnly: true });
		assert.doesNotMatch(sqlOf(patched), /unicase/i);
		assert.deepEqual(patched.prepare(rows).all(), before);
		assert.equal((patched.prepare("select count(*) c from notes").get() as { c: number }).c, readAnkiCollection(FIXTURE).notes.length);
		patched.close();
	});

	it("refuses a missing file and a non-collection file", () => {
		assert.throws(() => readAnkiCollection(path.join(root, "nope.anki2")), /not found/);
		const junk = path.join(root, "junk.anki2");
		fs.writeFileSync(junk, "not sqlite");
		assert.throws(() => readAnkiCollection(junk));
	});

	it("inspects decks and note types and suggests top-level deck = course", () => {
		const { inspection, suggestedPlan } = inspectAnki(FIXTURE, new Date("2026-11-04T00:00:00Z"));
		assert.deepEqual(inspection.decks.map((d) => `${d.name}:${d.cards}`), [
			"Anatomie:2",
			"Anatomie::Arm::Nerven:2",
			"Physiologie:2",
			"Tschechisch:1",
		]);
		assert.equal(inspection.cards, 7);
		assert.equal(inspection.reviews, 7);
		assert.deepEqual(suggestedPlan.courses.map((c) => c.id).sort(), ["anatomie", "physiologie", "tschechisch"]);
		const nerven = Object.values(suggestedPlan.decks).find((d) => d?.topic === "Arm::Nerven");
		assert.equal(nerven?.courseId, "anatomie");
		assert.ok(inspection.noteTypes.find((t) => t.name === "Fremd Vokabel")?.remapped);
	});

	it("imports cards, reviews and media; the schedule re-derives from the history", () => {
		const { store, mediaDest } = fresh();
		const { suggestedPlan } = inspectAnki(FIXTURE);
		const out = runAnkiImport(FIXTURE, suggestedPlan, { store, mediaDest });

		assert.equal(out.added.cards, 7);
		assert.equal(out.added.reviews, 7);
		assert.equal(out.added.courses, 3);
		assert.deepEqual(out.report.remapped, { "Fremd Vokabel": 1, Cloze: 1 });
		assert.equal(out.report.skippedReviews.cramOrManual, 1);

		const cards = store.readCards();
		const radialis = cards.find((c) => c.id === "anki_1793808385423");
		assert.equal(radialis?.kind, "basic");
		assert.equal(radialis?.courseId, "anatomie");
		assert.equal(radialis?.topic, "Arm::Nerven");
		assert.equal(radialis?.core, true);
		assert.equal(radialis?.fields.Front, "Nervus radialis: Innervation?");
		assert.deepEqual(radialis?.origin, { kind: "anki-import", noteId: 1793808385423 });
		assert.equal(cards.find((c) => c.id === "anki_1793808385424")?.variant, 1);

		const bildcloze = cards.find((c) => c.id === "anki_1793808385426");
		assert.equal(bildcloze?.kind, "cloze");
		assert.equal(bildcloze?.fields.LegendCloze, "1");
		assert.match(bildcloze?.fields.Text ?? "", /arm\.png/);

		const vocab = cards.find((c) => c.id === "anki_1793808385428");
		assert.equal(vocab?.suspended, true);
		assert.equal(vocab?.kind, "basic");
		assert.equal(vocab?.fields.Beispiel, "Můj dům [sound:dum.mp3]");

		// the filtered-deck card landed in its home course
		assert.equal(cards.find((c) => c.id === "anki_1793808385427")?.courseId, "physiologie");

		// five real reviews of the radialis card (the type-4 line is not one)
		const state = replay("anki_1793808385423", store.readReviews());
		assert.equal(state?.reps, 5);
		assert.ok((state?.lapses ?? 0) >= 1);

		assert.deepEqual(out.media.copied.sort(), ["arm.png", "dum.mp3"]);
		assert.deepEqual(fs.readdirSync(mediaDest).sort(), ["arm.png", "dum.mp3"]);
		assert.equal(out.media.missing.length, 0);
	});

	it("is idempotent: a second run adds nothing", () => {
		const { store, mediaDest } = fresh();
		const { suggestedPlan } = inspectAnki(FIXTURE);
		runAnkiImport(FIXTURE, suggestedPlan, { store, mediaDest });
		const again = runAnkiImport(FIXTURE, suggestedPlan, { store, mediaDest });
		assert.deepEqual(again.added, { courses: 0, cards: 0, reviews: 0 });
		assert.deepEqual(again.alreadyImported, { cards: 7, reviews: 7 });
		assert.deepEqual(again.media.copied, []);
		assert.equal(store.readReviews().length, 7);
	});

	it("does not touch an existing course or an edited card", () => {
		const { store, mediaDest } = fresh();
		const { suggestedPlan } = inspectAnki(FIXTURE);
		store.upsertCourse({ id: "anatomie", name: "Anatomie", bufferDays: 9, deadline: "2026-12-24", createdAt: "2026-01-01T00:00:00.000Z" });
		runAnkiImport(FIXTURE, suggestedPlan, { store, mediaDest });
		const first = store.readCards().find((c) => c.id === "anki_1793808385423");
		assert.ok(first);
		store.upsertCard({ ...first, tags: ["mine"] });
		runAnkiImport(FIXTURE, suggestedPlan, { store, mediaDest });
		assert.equal(store.readCourses().find((c) => c.id === "anatomie")?.deadline, "2026-12-24");
		assert.deepEqual(store.readCards().find((c) => c.id === "anki_1793808385423")?.tags, ["mine"]);
	});

	it("skips decks the owner did not map", () => {
		const { store, mediaDest } = fresh();
		const { suggestedPlan } = inspectAnki(FIXTURE);
		const only = Object.entries(suggestedPlan.decks).filter(([, t]) => t?.courseId === "physiologie");
		const out = runAnkiImport(FIXTURE, { courses: suggestedPlan.courses, decks: Object.fromEntries(only) }, { store, mediaDest });
		assert.equal(out.added.cards, 2);
		assert.equal(out.report.skippedCards.unmappedDeck, 5);
		assert.deepEqual(out.media.copied, []);
	});

	it("copies media safely: no overwrite, missing reported, no path escape", () => {
		const dest = path.join(root, "media-safety");
		const first = copyAnkiMedia(MEDIA, ["arm.png", "ghost.png", "../collection.anki2"], dest);
		assert.deepEqual(first.copied, ["arm.png"]);
		assert.deepEqual(first.missing.sort(), ["../collection.anki2", "ghost.png"]);
		fs.writeFileSync(path.join(dest, "arm.png"), "mine");
		const second = copyAnkiMedia(MEDIA, ["arm.png"], dest);
		assert.deepEqual(second.existing, ["arm.png"]);
		assert.equal(fs.readFileSync(path.join(dest, "arm.png"), "utf8"), "mine");
		assert.equal(fs.existsSync(path.join(root, "collection.anki2")), false);
	});
});

describe("Deadline Scheduler deadlines and the import plan from the UI", () => {
	const NOW = new Date("2026-11-04T00:00:00Z");
	const rec = (deadline: string, over: Record<string, unknown> = {}) => ({ deadline, buffer_days: 3, ...over });

	it("parses the Scheduler's config tolerantly and drops expired or malformed records", () => {
		const out = parseSchedulerDeadlines({
			"1": rec("2026-12-24", { new_per_day: 12, preset_id: 5 }),
			"2": rec("2026-12-31", { expired: true }),
			"3": rec("24.12.2026"),
			"4": "nonsense",
			"5": rec("2027-01-10", { buffer_days: 999 }),
		});
		assert.deepEqual(out, {
			"1": { deadline: "2026-12-24", bufferDays: 3, newPerDay: 12 },
			"5": { deadline: "2027-01-10", bufferDays: 60 },
		});
		assert.deepEqual(parseSchedulerDeadlines(null), {});
		assert.deepEqual(parseSchedulerDeadlines([1]), {});
	});

	const col = (deadlines: AnkiCollection["deadlines"]): AnkiCollection => ({
		decks: [
			{ id: 1, name: "Anatomie" },
			{ id: 2, name: "Anatomie\u001fArm" },
			{ id: 3, name: "Physio" },
		],
		noteTypes: [noteType({ id: 1, name: "Basic", fields: ["Front", "Back"] })],
		notes: [{ id: 100, mid: 1, tags: "", flds: "q\u001fa" }],
		cards: [
			{ id: 1, nid: 100, did: 2, ord: 0, queue: 0, odid: 0 },
			{ id: 2, nid: 100, did: 3, ord: 0, queue: 0, odid: 0 },
		],
		revlog: [],
		deadlines,
	});

	it("a course takes the deadline of its parent deck, even when the parent has no cards of its own", () => {
		const plan = suggestPlan(col({ "1": { deadline: "2026-12-24", bufferDays: 4, newPerDay: 9 } }), NOW);
		const anatomie = plan.courses.find((c) => c.id === "anatomie");
		assert.equal(anatomie?.deadline, "2026-12-24");
		assert.equal(anatomie?.bufferDays, 4);
		assert.equal(anatomie?.newPerDay, 9);
		assert.equal(plan.courses.find((c) => c.id === "physio")?.deadline, undefined);
		assert.deepEqual(plan.hints, []);
	});

	it("different deadlines in one course: the earliest wins, with a hint", () => {
		const plan = suggestPlan(
			col({ "1": { deadline: "2027-01-15", bufferDays: 5 }, "2": { deadline: "2026-12-24", bufferDays: 2 } }),
			NOW,
		);
		const anatomie = plan.courses.find((c) => c.id === "anatomie");
		assert.equal(anatomie?.deadline, "2026-12-24");
		assert.equal(anatomie?.bufferDays, 2);
		assert.equal(plan.hints.length, 1);
		assert.match(plan.hints[0] ?? "", /Anatomie.*2026-12-24, 2027-01-15.*earliest/);
	});

	it("reads the Scheduler record from a collection's config table", () => {
		const copy = path.join(root, "with-deadline.anki2");
		fs.copyFileSync(FIXTURE, copy);
		const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
		const db = new sqlite.DatabaseSync(copy);
		// decks.name carries Anki's custom "unicase" collation, so filter outside SQL
		const anatomie = (db.prepare("select id, name from decks").all() as { id: number; name: string }[]).find(
			(d) => d.name === "Anatomie",
		)!.id;
		db.prepare("insert into config (key, usn, mtime_secs, val) values (?, 0, 0, ?)").run(
			"deadline_scheduler_deadlines",
			Buffer.from(JSON.stringify({ [String(anatomie)]: rec("2026-12-24") })),
		);
		db.close();
		assert.deepEqual(readAnkiCollection(copy).deadlines, { [String(anatomie)]: { deadline: "2026-12-24", bufferDays: 3 } });
		const { suggestedPlan, existingCourses } = inspectAnki(copy, NOW, fresh().store);
		assert.equal(suggestedPlan.courses.find((c) => c.id === "anatomie")?.deadline, "2026-12-24");
		assert.deepEqual(existingCourses, []);
		assert.deepEqual(readAnkiCollection(FIXTURE).deadlines, {});
	});

	it("lists the collections of every profile folder and ignores the rest", () => {
		const base = path.join(root, "Anki2");
		for (const p of ["Benutzer 1", "Zweit", "addons21", "logs"]) fs.mkdirSync(path.join(base, p), { recursive: true });
		fs.copyFileSync(FIXTURE, path.join(base, "Benutzer 1", "collection.anki2"));
		fs.writeFileSync(path.join(base, "Zweit", "collection.anki2"), "x");
		fs.writeFileSync(path.join(base, "prefs21.db"), "x");
		const found = findAnkiCollections(base);
		assert.deepEqual(found.map((c) => c.profile), ["Benutzer 1", "Zweit"]);
		assert.equal(found[1]?.sizeBytes, 1);
		assert.equal(listAnkiCollections(path.join(root, "does-not-exist")).length, 0);
	});

	const valid = {
		courses: [{ id: "anatomie", name: " Anatomie ", deadline: "2026-12-24", bufferDays: 3, newPerDay: 10, createdAt: "x" }],
		decks: { "5": { courseId: "anatomie", topic: " Arm " }, "6": null, "7": { courseId: "old" } },
	};

	it("accepts a plan from the UI and cleans it; an existing course is a valid target", () => {
		const plan = parseImportPlan(valid, new Set(["old"]), NOW);
		assert.deepEqual(plan.courses, [
			{ id: "anatomie", name: "Anatomie", deadline: "2026-12-24", bufferDays: 3, newPerDay: 10, createdAt: NOW.toISOString() },
		]);
		assert.deepEqual(plan.decks, { "5": { courseId: "anatomie", topic: "Arm" }, "6": null, "7": { courseId: "old" } });
	});

	it("rejects malformed plans", () => {
		const bad = (mutate: (p: any) => void, re: RegExp) => {
			const p = structuredClone(valid);
			mutate(p);
			assert.throws(() => parseImportPlan(p, new Set(["old"]), NOW), (e) => e instanceof ImportPlanError && re.test(e.message));
		};
		bad((p) => (p.courses[0].id = "../x"), /course id/);
		bad((p) => (p.courses[0].name = "  "), /needs a name/);
		bad((p) => (p.courses[0].deadline = "24.12.2026"), /deadline/);
		bad((p) => (p.courses[0].bufferDays = -1), /buffer/);
		bad((p) => (p.courses[0].newPerDay = 0), /per day/);
		bad((p) => p.courses.push({ id: "anatomie", name: "dup" }), /duplicate/);
		bad((p) => (p.decks["5"] = { courseId: "ghost" }), /unknown course/);
		bad((p) => (p.decks["x"] = null), /bad deck id/);
		assert.throws(() => parseImportPlan("nope", new Set(), NOW), ImportPlanError);
	});

	it("the server only opens existing .anki2 files and rejects a bad plan before writing anything", () => {
		const { store, mediaDest } = fresh();
		const status = (code: number) => (e: unknown) => e instanceof StudyInputError && e.status === code;
		assert.throws(() => inspectAnki("relative/collection.anki2"), status(400));
		assert.throws(() => inspectAnki(path.join(root, "x.sqlite")), status(400));
		assert.throws(() => inspectAnki(path.join(root, "missing.anki2")), status(404));
		assert.throws(() => inspectAnki(42), status(400));
		const junk = path.join(root, "junk2.anki2");
		fs.writeFileSync(junk, "not sqlite");
		assert.throws(() => inspectAnki(junk), status(400));
		assert.throws(() => runAnkiImport(FIXTURE, { courses: [], decks: { "1": { courseId: "ghost" } } }, { store, mediaDest }), status(400));
		assert.equal(store.readCards().length, 0);
		assert.equal(store.readCourses().length, 0);
	});
});

describe("the subject level of the plan (first sub-deck = course, the levels below = topic)", () => {
	const NOW = new Date("2026-11-06T00:00:00Z");
	const S = "\u001f";
	const deadline = (d: string, over: Record<string, unknown> = {}) => ({ deadline: d, bufferDays: 3, ...over });
	// 1st Year > Anatomy > Bones | 1st Year > Biology > W1, W2 | 1st Year > Biophysics (own cards) + > Practice
	// | Anatomy > Muscles > 1 Upper limb | Tests > Junk
	const names = [
		`1st Year${S}Anatomy${S}Bones`,
		`1st Year${S}Biology${S}W1 Cell`,
		`1st Year${S}Biology${S}W2 DNA`,
		`1st Year${S}Biophysics`,
		`1st Year${S}Biophysics${S}Practice`,
		`Anatomy${S}Muscles${S}1 Upper limb`,
		`Tests${S}Junk`,
		`1st Year${S}Anatomy`, // a parent deck: no cards, only a Scheduler record
		`1st Year${S}Biology`,
	];
	const col = (deadlines: AnkiCollection["deadlines"]): AnkiCollection => ({
		decks: names.map((name, i) => ({ id: i + 1, name })),
		noteTypes: [noteType({ id: 1, name: "Basic", fields: ["Front", "Back"] })],
		notes: [{ id: 100, mid: 1, tags: "", flds: `q${S}a` }],
		cards: names.slice(0, 7).map((_, i) => ({ id: i + 1, nid: 100, did: i + 1, ord: i, queue: 0, odid: 0 })),
		revlog: [],
		deadlines,
	});

	it("placeDeck: level 0 is the old rule; level 1 takes the first sub-deck as the course", () => {
		assert.deepEqual(placeDeck(["1st Year", "Biology", "W1 Cell"]), { course: "1st Year", topic: "Biology::W1 Cell" });
		assert.deepEqual(placeDeck(["1st Year", "Biology", "W1 Cell"], 1), { course: "Biology", topic: "W1 Cell" });
		assert.deepEqual(placeDeck(["1st Year", "Biophysics"], 1), { course: "Biophysics" });
		assert.deepEqual(placeDeck(["Tests"], 1), { course: "Tests" }, "a deck that does not reach the level is its own course");
		assert.deepEqual(placeDeck(["A", "B", "C", "D"], 1), { course: "B", topic: "C::D" }, "deeper levels stay in the topic");
	});

	it("subjectLevel 1: Anatomy, Biology and Biophysics become courses; the decks below are the topics", () => {
		const plan = suggestPlan(col({}), NOW, { subjectLevel: 1 });
		const targetOf = (name: string) => plan.decks[String(names.indexOf(name) + 1)];
		assert.deepEqual(targetOf(`1st Year${S}Anatomy${S}Bones`), { courseId: "anatomy", topic: "Bones" });
		assert.deepEqual(targetOf(`1st Year${S}Biology${S}W2 DNA`), { courseId: "biology", topic: "W2 DNA" });
		assert.deepEqual(targetOf(`1st Year${S}Biophysics`), { courseId: "biophysics" });
		assert.deepEqual(targetOf(`1st Year${S}Biophysics${S}Practice`), { courseId: "biophysics", topic: "Practice" });
		assert.deepEqual(targetOf(`Anatomy${S}Muscles${S}1 Upper limb`), { courseId: "muscles", topic: "1 Upper limb" }, "strict rule, before any exception");
		assert.ok(!plan.courses.some((c) => c.id === "1st-year"), "the year is no course");
	});

	it("retarget: an exception can merge a tree into another course or leave it out, and the plan follows", () => {
		const retarget = (levels: readonly string[], placed: { course: string; topic?: string }) => {
			if (levels[0] === "Tests") return null;
			if (levels[0] === "Anatomy") return { course: "Anatomy", topic: levels.slice(2).join("::") };
			return placed;
		};
		const plan = suggestPlan(col({}), NOW, { subjectLevel: 1, retarget });
		const targetOf = (name: string) => plan.decks[String(names.indexOf(name) + 1)];
		assert.equal(targetOf(`Tests${S}Junk`), null);
		assert.deepEqual(targetOf(`Anatomy${S}Muscles${S}1 Upper limb`), { courseId: "anatomy", topic: "1 Upper limb" });
		assert.deepEqual(plan.courses.map((c) => c.id).sort(), ["anatomy", "biology", "biophysics"]);
	});

	it("deadlines follow the course: a parent deck's record counts, the earliest wins, a skipped deck's record is ignored", () => {
		const id = (name: string) => String(names.indexOf(name) + 1);
		const plan = suggestPlan(
			col({
				[id(`1st Year${S}Anatomy`)]: deadline("2026-11-13"),
				[id(`1st Year${S}Biology${S}W1 Cell`)]: deadline("2026-12-19", { newPerDay: 13 }),
				[id(`1st Year${S}Biology${S}W2 DNA`)]: deadline("2026-12-20", { newPerDay: 13 }),
				[id(`1st Year${S}Biophysics`)]: deadline("2027-01-04", { bufferDays: 5, newPerDay: 7 }),
				[id(`Tests${S}Junk`)]: deadline("2026-11-20"),
			}),
			NOW,
			{ subjectLevel: 1, retarget: (levels, placed) => (levels[0] === "Tests" ? null : placed) },
		);
		const course = (cid: string) => plan.courses.find((c) => c.id === cid)!;
		assert.equal(course("anatomy").deadline, "2026-11-13");
		assert.equal(course("biophysics").deadline, "2027-01-04");
		assert.equal(course("biophysics").newPerDay, 7, "one deck, one number: kept");
		assert.equal(course("biology").deadline, "2026-12-19", "the earliest of its topics");
		assert.equal(course("biology").newPerDay, undefined, "two decks' per-day numbers are no course number: automatic");
		assert.equal(plan.hints.length, 1);
		assert.match(plan.hints[0] ?? "", /Biology.*2026-12-19, 2026-12-20.*earliest.*automatic/);
		assert.equal(plan.courses.some((c) => c.deadline === "2026-11-20"), false, "the skipped deck's deadline is not used");
	});
});
