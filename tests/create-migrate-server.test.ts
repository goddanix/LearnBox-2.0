/**
 * Bringing everything over from MedAnki (src/server/create-migrate.ts) from a throw-away folder shaped like <MedAnki>/data —
 * never the real one. The folder must come out of every run exactly as it went in.
 */

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { type CardsJob, CreateInputError, type LectureSource } from "../src/core/contracts.ts";
import type { LibraryStore } from "../src/core/ports.ts";
import { importMedAnki, type MigrateDeps, scanMedAnki } from "../src/server/create-migrate.ts";
import { createAudioStore } from "../src/store/audio.ts";
import { createCreateStore } from "../src/store/create.ts";
import { createNotesStore } from "../src/store/notes.ts";
import { createStudyStore } from "../src/store/study.ts";
import { createVaultSettings } from "../src/store/vault-settings.ts";
import { textPdf } from "./fixtures/text-pdf.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-migrate-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const NOW = new Date(2026, 10, 5, 10, 0, 0);
const KEY = "KEY-THAT-MUST-NEVER-TRAVEL-0123456789";
const ANATOMY = "fac3b82a0";
const BIOPHYS = "f4c32d308";
const JOB_C = "20261104-173330-e676"; // cards, in Anatomy, with a pushed card and an occlusion card
const JOB_P = "20261017-013917-69d3"; // a practical: pages never made, in Biophysics
const JOB_S = "20261030-221339-fa09"; // no course id, but a subject
const JOB_N = "20261104-173312-6ff8"; // no course at all

const card = (id: string, over: Record<string, unknown> = {}) => ({
	page: Number(id.slice(1, 4)),
	type: "basic",
	priority: 1,
	why_type: "x",
	extra: "",
	evidence: "",
	tags: ["Anatomie"],
	warnings: [],
	deleted: false,
	include: true,
	manual: false,
	source_ids: ["L1"],
	source_bbox: [0.1, 0.1, 0.4, 0.2],
	image: null,
	front: `Question ${id}?`,
	back: `Answer ${id}.`,
	id,
	...over,
});

const occlusion = (id: string, over: Record<string, unknown> = {}) =>
	card(id, {
		type: "image_occlusion",
		front: undefined,
		back: undefined,
		header: "Name it",
		mode: "one",
		figure_bbox: [0, 0, 1, 1],
		figure_exact: false,
		mask_exact: false,
		label: "Tibia",
		hint: "",
		boxes: [[0.1, 0.1, 0.2, 0.2]],
		all_boxes: [[0.1, 0.1, 0.2, 0.2]],
		marker_bbox: null,
		needs_check: false,
		question_file: "io_q.jpg",
		answer_file: "io_a.jpg",
		fig_hash: "cd".repeat(32),
		mask_v: 2,
		...over,
	});

interface JobOpts {
	subject?: string;
	courseId?: string;
	state?: string;
	kind?: string;
	pages: Record<string, object>;
	cards?: Record<number, object[]>;
	layouts?: number[];
	extra?: Record<string, unknown>;
}

function writeJob(dataDir: string, id: string, opts: JobOpts): string {
	const dir = path.join(dataDir, "jobs", id);
	fs.mkdirSync(path.join(dir, "cards"), { recursive: true });
	fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
	fs.mkdirSync(path.join(dir, "media"), { recursive: true });
	fs.writeFileSync(path.join(dir, "source.pdf"), textPdf([`Source of ${id}`], id));
	fs.writeFileSync(
		path.join(dir, "meta.json"),
		JSON.stringify({
			id,
			name: `Job ${id.slice(-4)}`,
			filename: `Job ${id.slice(-4)}.pdf`,
			created: "2026-11-04T17:33:30",
			n_pages: Object.keys(opts.pages).length,
			headings: Object.keys(opts.pages).map((p) => `Heading ${p}`),
			...(opts.subject ? { subject: opts.subject } : {}),
			settings: { model: "sonnet", density: "knapp", language: "en", io_mode: "auto", latin_terms: null, kind: opts.kind ?? "vorlesung", course_id: opts.courseId ?? "", page_from: 1, page_to: Object.keys(opts.pages).length, concurrency: 2, focus_topics: ["Vertebra"], focus_strict: false },
			state: opts.state ?? "done",
			pages: opts.pages,
			...opts.extra,
		}),
	);
	for (const [page, cards] of Object.entries(opts.cards ?? {})) {
		fs.writeFileSync(path.join(dir, "cards", `p${String(page).padStart(3, "0")}.json`), JSON.stringify({ page: Number(page), page_type: "text", skip: false, skip_reason: "", topic: `Topic ${page}`, cards, dropped: [], status: "done" }));
	}
	for (const page of opts.layouts ?? []) {
		fs.writeFileSync(
			path.join(dir, "pages", `p${String(page).padStart(3, "0")}.layout.json`),
			JSON.stringify({ width_pt: 612, height_pt: 792, lines: [{ id: "L1", text: "Hello", bbox: [0.1, 0.1, 0.4, 0.2], tight: [0.1, 0.12, 0.4, 0.18], size: 10, src: "pdf", bold: true, italic: false, underline: false, in_figure: false }], figures: [], chars: 5, title: "Hello", legends: [] }),
		);
	}
	return dir;
}

function medAnkiFolder(): string {
	const dataDir = fs.mkdtempSync(path.join(root, "medanki-"));
	const vault = path.join(dataDir, "..", `vault-${path.basename(dataDir)}`);
	fs.mkdirSync(vault, { recursive: true });
	fs.writeFileSync(
		path.join(dataDir, "settings.json"),
		JSON.stringify({
			subjects: ["Anatomy", "Biophysics"],
			courses: [
				{ id: ANATOMY, name: "Anatomy", topics: ["Vertebra", "Pelvis"], strict: false },
				{ id: BIOPHYS, name: "Biophysics", topics: ["Acoustics"], strict: true },
			],
			vault_path: path.resolve(vault),
			elevenlabs_api_key: KEY,
			elevenlabs_voice_id: "VoiceXYZ_9",
			link_result: { notes: 14, own: 14, linked: 13, links: 17, written: 13, removed: 0, llm: true, llm_failed: 0, colors: false, at: "2026-10-09T12:01:25" },
		}),
	);

	const c = writeJob(dataDir, JOB_C, {
		courseId: ANATOMY,
		pages: { "1": { status: "done", error: null, n_cards: 3, topic: "Topic 1", page_type: "text" }, "2": { status: "skipped", error: null, n_cards: 0, topic: "Cover", page_type: "titel" } },
		cards: { 1: [card("p001-c01"), occlusion("p001-c02"), card("p001-c03", { type: "cloze", text: "x {{c1::y}}", front: undefined, back: undefined, deleted: true })] },
		layouts: [1],
		extra: { retention_hint: "", latin_enabled: true, glossary: [{ canonical: "Articulatio coxae", variants: ["Hip joint"] }] },
	});
	fs.writeFileSync(path.join(c, "cards", "p002.json"), JSON.stringify({ page: 2, page_type: "titel", skip: true, skip_reason: "Title page", topic: "Cover", cards: [], dropped: [], status: "skipped" }));
	fs.writeFileSync(path.join(c, "pages", "p001.png"), "PAGE-ONE-PICTURE");
	fs.writeFileSync(path.join(c, "pages", "p001.jpg"), "THUMBNAIL");
	// page 2 has no picture
	fs.writeFileSync(path.join(c, "media", "io_q.jpg"), "QUESTION-PICTURE");
	fs.writeFileSync(path.join(c, "media", "orphan.jpg"), "NO CARD NAMES THIS");
	// io_a.jpg is missing on purpose

	writeJob(dataDir, JOB_P, { courseId: BIOPHYS, state: "interrupted", kind: "praktikum", pages: { "1": { status: "pending", error: null, n_cards: 0 }, "2": { status: "pending", error: null, n_cards: 0 } }, layouts: [1] });
	writeJob(dataDir, JOB_S, { subject: "anatomy", pages: { "1": { status: "done", error: null, n_cards: 1 } }, cards: { 1: [card("p001-c01"), card("p001-c02", { deleted: true })] } });
	writeJob(dataDir, JOB_N, { pages: { "1": { status: "pending", error: null, n_cards: 0 } } });
	// not jobs: no meta.json, no source PDF
	fs.mkdirSync(path.join(dataDir, "jobs", "20261005-195540-37ef", "audio"), { recursive: true });
	fs.mkdirSync(path.join(dataDir, "jobs", "20261006-000000-aaaa"), { recursive: true });
	fs.writeFileSync(path.join(dataDir, "jobs", "20261006-000000-aaaa", "meta.json"), JSON.stringify({ pages: {} }));

	// notes of Anatomy (one source = JOB_C, one figure), audio of Biophysics
	const notes = path.join(dataDir, "courses", ANATOMY);
	fs.mkdirSync(path.join(notes, "figs"), { recursive: true });
	fs.writeFileSync(path.join(notes, "figs", "D1_p001_F1.png"), "FIGURE-PNG");
	fs.writeFileSync(path.join(notes, "figs", "unused.png"), "NOT IN A NOTE");
	fs.writeFileSync(
		path.join(notes, "themen_notizen.json"),
		JSON.stringify({
			status: "done",
			error: "",
			name: "Anatomy",
			created: "2026-10-09",
			sources: [{ ref: "D1", job_id: JOB_C, name: "Job e676", pdf_file: "Job e676.pdf" }],
			items: [{ id: "t01", ix: "1", topic: "Vertebra", kind: "note", skip_reason: "", cards: "3", pages: "1", refs: ["D1"], markdown: "> [!abstract] Kernaussagen\n> - **Vertebra**", words: "120", figures: [{ id: "D1_p001_F1", file: "D1_p001_F1.png", src: "figs/D1_p001_F1.png", page: 1, ref: "D1", caption: "A vertebra" }], include: true, error: "" }],
			saved: { path: path.join(vault, "Anatomy", "Themen", "00 Übersicht.md"), url: "obsidian://open?path=x", created: true, vault: path.resolve(vault), count: 1, at: "2026-10-09" },
		}),
	);
	const audio = path.join(dataDir, "courses", BIOPHYS, "audio");
	fs.mkdirSync(audio, { recursive: true });
	fs.writeFileSync(path.join(audio, "summary.mp3"), "ID3-FAKE-MP3-BYTES");
	fs.writeFileSync(path.join(audio, "audio.json"), JSON.stringify({ status: "done", title: "Biophysics Labs", script: "Hello, this is the script.", file: "summary.mp3", error: "", job_ids: [JOB_P] }));
	return dataDir;
}

/** The files under a folder with a hash of each (to see that nothing changed). */
function tree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out[path.relative(dir, p)] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
		}
	};
	walk(dir);
	return out;
}

function setup(opts: { failPdf?: (fileName: string) => boolean } = {}) {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const sources = new Map<string, { source: LectureSource; file: string }>();
	const library: LibraryStore = {
		add: () => {
			throw new Error("not used");
		},
		get: (id) => sources.get(id)?.source ?? null,
		list: () => [...sources.values()].map((e) => e.source),
		update: () => null,
		pdfPath: (id) => sources.get(id)?.file ?? null,
		remove: () => false,
	};
	const study = createStudyStore({ courses: path.join(dir, "courses.jsonl"), cards: path.join(dir, "cards.jsonl"), reviews: path.join(dir, "reviews.jsonl") });
	study.upsertCourse({ id: "first-year", name: "1st Year", bufferDays: 5, deadline: "2026-11-13", createdAt: NOW.toISOString() });
	// the Anki import's card for MedAnki's pushed card JOB_C / p001-c01 (a cloze note made two cards)
	for (const k of [0, 1]) {
		study.upsertCard({ id: `anki_${k}`, courseId: "first-year", kind: "cloze", fields: { Text: "x" }, tags: ["MedAnki::Kernwissen", `MedAnkiID_${JOB_C}_p001-c01`], core: true, origin: { kind: "anki-import", noteId: 7 }, createdAt: NOW.toISOString() });
	}
	const deps: MigrateDeps = {
		create: createCreateStore(path.join(dir, "create")),
		library,
		study,
		ask: async () => {
			throw new Error("not used");
		},
		renderPage: async () => new Uint8Array(),
		pageLines: async () => [],
		documentText: async () => "",
		addPdf: async (fileName, data) => {
			if (opts.failPdf?.(fileName)) throw new Error("the library is full");
			const sha256 = crypto.createHash("sha256").update(data).digest("hex");
			const existing = [...sources.values()].find((e) => e.source.sha256 === sha256);
			if (existing) return existing.source;
			const id = `lec_${sources.size + 1}`;
			const source: LectureSource = { v: 1, id, title: fileName.replace(/\.pdf$/, ""), fileName, bytes: data.length, sha256, pages: 2, addedAt: NOW.toISOString(), status: "stored" };
			sources.set(id, { source, file: path.join(dir, `${id}.pdf`) });
			return source;
		},
		now: () => NOW,
		retryDelayMs: 0,
		notes: createNotesStore(path.join(dir, "notes")),
		audio: createAudioStore(path.join(dir, "audio")),
		vault: createVaultSettings(path.join(dir, "vault.json"), { home: dir }),
	};
	return { dir, deps, study, sources };
}

const cardsJob = (deps: MigrateDeps, id: string): CardsJob => {
	const job = deps.create.get(`crt_legacy_${id}`);
	assert.ok(job && job.kind === "cards", `job ${id} is in Learnbox`);
	return job;
};

describe("scanMedAnki (the dry run)", () => {
	it("lists the subjects, the jobs with their cards and links, and the vault — and writes nothing, anywhere", () => {
		const dataDir = medAnkiFolder();
		const { dir, deps } = setup();
		const medBefore = tree(dataDir);
		const ownBefore = tree(dir);

		const scan = scanMedAnki(dataDir, deps);

		assert.equal(scan.dataDir, dataDir);
		assert.deepEqual(scan.courses, [
			{ id: ANATOMY, name: "Anatomy", topics: 2, alreadyImported: false, notes: 1, audio: false },
			{ id: BIOPHYS, name: "Biophysics", topics: 1, alreadyImported: false, notes: 0, audio: true },
		]);
		assert.deepEqual(
			scan.jobs.map((j) => ({ id: j.id, pages: j.pages, cards: j.cards, state: j.state, courseId: j.courseId, linkable: j.linkable, alreadyImported: j.alreadyImported })),
			[
				{ id: JOB_P, pages: 2, cards: 0, state: "stopped", courseId: BIOPHYS, linkable: 0, alreadyImported: false },
				{ id: JOB_S, pages: 1, cards: 1, state: "done", courseId: ANATOMY, linkable: 0, alreadyImported: false },
				{ id: JOB_N, pages: 1, cards: 0, state: "done", courseId: null, linkable: 0, alreadyImported: false },
				{ id: JOB_C, pages: 2, cards: 2, state: "done", courseId: ANATOMY, linkable: 1, alreadyImported: false },
			].sort((a, b) => a.id.localeCompare(b.id)),
		);
		assert.equal(scan.vault.medankiExists, true);
		assert.equal(scan.vault.willSet, true);
		assert.equal(scan.vault.custom, false);
		assert.equal(scan.vault.medanki, JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")).vault_path);
		assert.deepEqual(scan.mcq.jobs, []);

		assert.deepEqual(tree(dataDir), medBefore, "MedAnki's folder is as it was");
		assert.deepEqual(tree(dir), ownBefore, "nothing written into Learnbox either");
	});

	it("an empty or missing MedAnki folder lists nothing", () => {
		const { deps } = setup();
		const scan = scanMedAnki(fs.mkdtempSync(path.join(root, "empty-")), deps);
		assert.deepEqual([scan.courses, scan.jobs], [[], []]);
		assert.equal(scan.vault.willSet, false);
		assert.throws(() => scanMedAnki("relative/path", deps), CreateInputError);
	});

	it("says what is there already after an import", async () => {
		const dataDir = medAnkiFolder();
		const { deps } = setup();
		await importMedAnki({ path: dataDir }, deps);
		const scan = scanMedAnki(dataDir, deps);
		assert.ok(scan.jobs.every((j) => j.alreadyImported));
		assert.ok(scan.courses.every((c) => c.alreadyImported));
		assert.deepEqual(scan.courses.map((c) => [c.notes, c.audio]), [[0, false], [0, false]], "notes and audio are here: none would come along");
		assert.equal(scan.vault.willSet, false, "the vault is chosen now");
	});
});

describe("importMedAnki", () => {
	it("brings the subjects over as courses with the vault key, topics and no deadline; the Anki cards stay where they are", async () => {
		const dataDir = medAnkiFolder();
		const { deps, study } = setup();
		const out = await importMedAnki({ path: dataDir }, deps);

		assert.equal(out.courses, 2);
		const courses = study.readCourses();
		assert.deepEqual(courses.map((c) => c.id), ["first-year", ANATOMY, BIOPHYS]);
		const anatomy = courses.find((c) => c.id === ANATOMY)!;
		assert.deepEqual({ name: anatomy.name, topics: anatomy.topics, strict: anatomy.strictTopics, vaultKey: anatomy.vaultKey, deadline: anatomy.deadline, buffer: anatomy.bufferDays }, { name: "Anatomy", topics: ["Vertebra", "Pelvis"], strict: undefined, vaultKey: ANATOMY, deadline: undefined, buffer: 5 });
		assert.equal(courses.find((c) => c.id === BIOPHYS)!.strictTopics, true);
		assert.equal(courses.find((c) => c.id === "first-year")!.deadline, "2026-11-13", "the old course is untouched");
		assert.equal(study.readCards().length, 2);
		assert.ok(study.readCards().every((c) => c.courseId === "first-year"));
	});

	it("a PDF job: record, counters, glossary, headings, the PDF in the library — in the course MedAnki had it in", async () => {
		const dataDir = medAnkiFolder();
		const { deps, sources } = setup();
		const out = await importMedAnki({ path: dataDir }, deps);
		assert.equal(out.jobs, 4);
		assert.equal(out.alreadyThere, 0);
		assert.equal(sources.size, 4);

		const job = cardsJob(deps, JOB_C);
		assert.equal(job.name, "Job e676");
		assert.equal(job.courseId, ANATOMY);
		assert.equal(job.state, "done");
		assert.equal(job.nPages, 2);
		assert.equal(job.settings.density, "brief", "knapp");
		assert.equal(job.settings.latinTerms, "auto", "MedAnki wrote None");
		assert.deepEqual(job.settings.focusTopics, ["Vertebra"]);
		assert.equal(job.retentionHint, "");
		assert.equal(job.latin, true);
		assert.deepEqual(job.glossary, [{ canonical: "Articulatio coxae", variants: ["Hip joint"] }]);
		assert.deepEqual(job.headings, { "1": "Heading 1", "2": "Heading 2" });
		assert.equal(job.createdAt, new Date("2026-11-04T17:33:30").toISOString());
		assert.equal(deps.library.get(job.lectureId)?.fileName, "Job e676.pdf");
		assert.deepEqual(job.pages, {
			"1": { status: "done", count: 2, adopted: 1, topic: "Topic 1", skipped: false },
			"2": { status: "done", count: 0, adopted: 0, topic: "Cover", skipped: true },
		});

		const practical = cardsJob(deps, JOB_P);
		assert.equal(practical.state, "stopped");
		assert.equal(practical.settings.kind, "practical");
		assert.equal(practical.courseId, BIOPHYS);
		assert.deepEqual(practical.pages, { "1": { status: "pending", count: 0, adopted: 0 }, "2": { status: "pending", count: 0, adopted: 0 } });
		assert.equal("glossary" in practical, false, "MedAnki had built none: a run will");
		assert.equal("retentionHint" in practical, false);

		assert.equal(cardsJob(deps, JOB_S).courseId, ANATOMY, "found by the subject's name");
		assert.equal("courseId" in cardsJob(deps, JOB_N), false, "no course: the learner chooses");
	});

	it("the cards come as they were (the pushed one is adopted, the occlusion keeps its masks and hash, the old cloze is kept apart)", async () => {
		const dataDir = medAnkiFolder();
		const { deps } = setup();
		const out = await importMedAnki({ path: dataDir }, deps);
		assert.equal(out.drafts, 3, "two cards of the first job and one of the third; the old cloze is not a draft, a card thrown away is not counted");
		assert.equal(deps.create.readCardPage(`crt_legacy_${JOB_S}`, 1)!.cards.length, 2, "but it comes along, as thrown away");
		assert.equal(deps.create.readCardPage(`crt_legacy_${JOB_S}`, 1)!.cards[1]!.deleted, true);
		assert.equal(out.linked, 1);

		const page = deps.create.readCardPage(`crt_legacy_${JOB_C}`, 1)!;
		assert.equal(page.topic, "Topic 1");
		assert.equal(page.cards.length, 2);
		const [basic, occ] = page.cards;
		assert.deepEqual(basic!.adopted, { courseId: "first-year", cardId: "anki_0", at: NOW.toISOString() }, "the first card of the note");
		assert.equal(occ!.adopted, undefined, "an occlusion card has no study card: it stays a draft");
		assert.equal(occ!.type, "image_occlusion");
		assert.equal(occ!.type === "image_occlusion" && occ!.figHash, "cd".repeat(32));
		assert.equal(occ!.type === "image_occlusion" && occ!.maskV, 2);
		assert.equal(page.dropped.length, 1);
		assert.match(page.dropped[0]!.reason, /old cloze/i);
		assert.equal(deps.create.readCardPage(`crt_legacy_${JOB_C}`, 2)!.status, "skipped");
	});

	it("only the pictures the cards name are copied; one MedAnki lost is counted", async () => {
		const dataDir = medAnkiFolder();
		const { deps, dir } = setup();
		const out = await importMedAnki({ path: dataDir }, deps);
		assert.equal(out.media, 1);
		assert.equal(out.missingMedia, 1);
		const media = path.join(dir, "create", `crt_legacy_${JOB_C}`, "media");
		assert.deepEqual(fs.readdirSync(media), ["io_q.jpg"]);
		assert.equal(fs.readFileSync(path.join(media, "io_q.jpg"), "utf8"), "QUESTION-PICTURE");
	});

	it("the page layouts come with their line ids, in Learnbox's shape", async () => {
		const dataDir = medAnkiFolder();
		const { deps } = setup();
		await importMedAnki({ path: dataDir }, deps);
		const layout = deps.create.readLayout(`crt_legacy_${JOB_C}`, 1)!;
		assert.equal(layout.widthPt, 612);
		assert.equal(layout.lines[0]!.id, "L1");
		assert.equal(layout.lines[0]!.inFigure, false);
		assert.equal(deps.create.readLayout(`crt_legacy_${JOB_C}`, 2), null, "no file: none");
	});

	it("the page pictures come along (the PNG, not the thumbnail), for the pages that have one", async () => {
		const dataDir = medAnkiFolder();
		const { deps, dir } = setup();
		const out = await importMedAnki({ path: dataDir }, deps);
		assert.equal(out.pictures, 1);
		const pages = path.join(dir, "create", `crt_legacy_${JOB_C}`, "work", "pages");
		assert.deepEqual(fs.readdirSync(pages), ["p001.png"]);
		assert.equal(fs.readFileSync(path.join(pages, "p001.png"), "utf8"), "PAGE-ONE-PICTURE");
	});

	it("the topic notes come with their figures and sources, and a re-save will find the notes already in the vault", async () => {
		const dataDir = medAnkiFolder();
		const { deps, dir } = setup();
		const out = await importMedAnki({ path: dataDir }, deps);
		assert.equal(out.notes, 1);
		const doc = deps.notes.read(ANATOMY)!;
		assert.equal(doc.status, "done");
		assert.equal(doc.items[0]!.topic, "Vertebra");
		assert.equal(doc.items[0]!.words, 120);
		assert.deepEqual(doc.sources.map((s) => s.jobId), [`crt_legacy_${JOB_C}`]);
		assert.equal(doc.saved?.created, true);
		assert.deepEqual(fs.readdirSync(path.join(dir, "notes", ANATOMY, "figs")), ["D1_p001_F1.png"], "only the figures a note uses");
		assert.equal(deps.notes.read(BIOPHYS), null);
	});

	it("the audio summary comes with its MP3, and the voice", async () => {
		const dataDir = medAnkiFolder();
		const { deps } = setup();
		const out = await importMedAnki({ path: dataDir }, deps);
		assert.equal(out.audio, 1);
		const doc = deps.audio.read(BIOPHYS)!;
		assert.deepEqual({ status: doc.status, title: doc.title, script: doc.script, file: doc.file, jobIds: doc.jobIds }, { status: "draft", title: "Biophysics Labs", script: "Hello, this is the script.", file: "summary.mp3", jobIds: [`crt_legacy_${JOB_P}`] });
		assert.ok(doc.audioAt.startsWith("20"), "when the MP3 was made");
		assert.equal(fs.readFileSync(deps.audio.fileOf(BIOPHYS, "summary.mp3")!, "utf8"), "ID3-FAKE-MP3-BYTES");
		assert.equal(deps.audio.voice(), "VoiceXYZ_9");
		assert.equal(deps.audio.read(ANATOMY), null);
	});

	it("MedAnki's vault becomes the vault, with its last linking result", async () => {
		const dataDir = medAnkiFolder();
		const { deps } = setup();
		const out = await importMedAnki({ path: dataDir }, deps);
		assert.equal(out.vault, "set");
		const here = deps.vault.location();
		assert.equal(here.custom, true);
		assert.equal(here.path, path.resolve(JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")).vault_path));
		assert.equal(deps.vault.lastLink()?.linked, 13);
		assert.equal(deps.vault.lastLink()?.llmFailed, 0);
	});

	it("a vault the learner chose already is left alone", async () => {
		const dataDir = medAnkiFolder();
		const { deps, dir } = setup();
		const mine = path.join(dir, "my-vault");
		deps.vault.setPath(mine);
		const out = await importMedAnki({ path: dataDir }, deps);
		assert.equal(out.vault, "kept");
		assert.equal(deps.vault.location().path, mine);
		assert.equal(deps.vault.lastLink(), null);
	});

	it("never takes the ElevenLabs key — nothing Learnbox wrote holds it — and leaves MedAnki's folder exactly as it was", async () => {
		const dataDir = medAnkiFolder();
		const { deps, dir } = setup();
		const before = tree(dataDir);
		await importMedAnki({ path: dataDir }, deps);
		assert.deepEqual(tree(dataDir), before);
		for (const file of Object.keys(tree(dir))) assert.ok(!fs.readFileSync(path.join(dir, file)).includes(KEY), `${file} must not hold the key`);
	});

	it("a second import does nothing again (the vault, chosen by the first, is kept)", async () => {
		const dataDir = medAnkiFolder();
		const { deps } = setup();
		await importMedAnki({ path: dataDir }, deps);
		const again = await importMedAnki({ path: dataDir }, deps);
		assert.deepEqual({ ...again, mcq: undefined }, { courses: 0, jobs: 0, alreadyThere: 4, drafts: 0, linked: 0, media: 0, missingMedia: 0, pictures: 0, notes: 0, audio: 0, vault: "kept", mcq: undefined });
	});

	it("notes and audio the learner has already are not overwritten, and a course with the same name gets a suffix", async () => {
		const dataDir = medAnkiFolder();
		const { deps, study } = setup();
		study.upsertCourse({ id: "mine", name: "anatomy", bufferDays: 5, createdAt: NOW.toISOString() });
		deps.notes.update(ANATOMY, (d) => Object.assign(d, { status: "done", items: [{ id: "t01", ix: 1, topic: "Mine", kind: "note", skipReason: "", cards: 0, pages: 0, refs: [], markdown: "mine", words: 1, figures: [], include: true, error: "" }] }));
		deps.audio.update(BIOPHYS, (d) => Object.assign(d, { status: "draft", script: "Mine." }));
		const out = await importMedAnki({ path: dataDir }, deps);
		assert.equal(study.readCourses().find((c) => c.id === ANATOMY)!.name, "Anatomy (MedAnki)");
		assert.equal(out.notes, 0);
		assert.equal(out.audio, 0);
		assert.equal(deps.notes.read(ANATOMY)!.items[0]!.topic, "Mine");
		assert.equal(deps.audio.read(BIOPHYS)!.script, "Mine.");
	});
});

describe("the learner's choice of jobs", () => {
	it("brings only the chosen jobs, in the course chosen (or none)", async () => {
		const dataDir = medAnkiFolder();
		const { deps } = setup();
		const out = await importMedAnki({ path: dataDir, jobs: [{ id: JOB_C, courseId: BIOPHYS }, { id: JOB_N, courseId: ANATOMY }, { id: JOB_S, courseId: null }] }, deps);
		assert.equal(out.jobs, 3);
		assert.equal(deps.create.get(`crt_legacy_${JOB_P}`), null);
		assert.equal(cardsJob(deps, JOB_C).courseId, BIOPHYS);
		assert.equal(cardsJob(deps, JOB_N).courseId, ANATOMY);
		assert.equal("courseId" in cardsJob(deps, JOB_S), false);
		// the later import brings the rest
		const rest = await importMedAnki({ path: dataDir }, deps);
		assert.equal(rest.jobs, 1);
		assert.equal(rest.alreadyThere, 3);
	});

	it("a course of Learnbox's own can be chosen too", async () => {
		const dataDir = medAnkiFolder();
		const { deps } = setup();
		await importMedAnki({ path: dataDir, jobs: [{ id: JOB_N, courseId: "first-year" }] }, deps);
		assert.equal(cardsJob(deps, JOB_N).courseId, "first-year");
	});

	it("refuses a job or a course that is not there — before anything is written", async () => {
		const dataDir = medAnkiFolder();
		const { deps, dir } = setup();
		const before = tree(dir);
		await assert.rejects(importMedAnki({ path: dataDir, jobs: [{ id: "nope", courseId: null }] }, deps), (e) => e instanceof CreateInputError && e.status === 400);
		await assert.rejects(importMedAnki({ path: dataDir, jobs: [{ id: JOB_C, courseId: "nope" }] }, deps), (e) => e instanceof CreateInputError && e.status === 400);
		assert.deepEqual(tree(dir), before, "not even the subjects were made");
		assert.equal(deps.create.list().length, 0);
		// a course this very import is about to make may be chosen
		await importMedAnki({ path: dataDir, jobs: [{ id: JOB_C, courseId: BIOPHYS }] }, deps);
		assert.equal(cardsJob(deps, JOB_C).courseId, BIOPHYS);
	});
});

describe("a run that is cut off, and two at once", () => {
	it("a failed job leaves nothing half-there, the others stay, and the next import does the rest", async () => {
		const dataDir = medAnkiFolder();
		const failing = setup({ failPdf: (name) => name.startsWith(`Job ${JOB_S.slice(-4)}`) });
		await assert.rejects(importMedAnki({ path: dataDir }, failing.deps), /library is full/);
		const done = failing.deps.create.list().map((j) => j.id);
		assert.ok(!done.includes(`crt_legacy_${JOB_S}`), "the failed job has no record");
		assert.ok(done.length < 4);

		// the same stores, the library working again
		const ok = { ...failing.deps, addPdf: setup().deps.addPdf };
		const out = await importMedAnki({ path: dataDir }, ok);
		assert.equal(out.alreadyThere, done.length);
		assert.equal(out.jobs, 4 - done.length);
		assert.equal(ok.create.list().length, 4);
	});

	it("a second import while one runs is refused, and the flag is free again afterwards", async () => {
		const dataDir = medAnkiFolder();
		const { deps } = setup();
		const first = importMedAnki({ path: dataDir }, deps);
		await assert.rejects(importMedAnki({ path: dataDir }, deps), (e) => e instanceof CreateInputError && e.status === 409);
		await first;
		const third = await importMedAnki({ path: dataDir }, deps);
		assert.equal(third.jobs, 0);
	});
});
