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
	mediaRefs,
	suggestPlan,
	type AnkiCollection,
	type AnkiNoteTypeRow,
} from "../src/core/anki-import.ts";
import { replay } from "../src/core/fsrs.ts";
import { copyAnkiMedia, readAnkiCollection } from "../src/store/anki-source.ts";
import { inspectAnki, runAnkiImport } from "../src/server/anki-import.ts";
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
