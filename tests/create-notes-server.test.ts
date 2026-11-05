/**
 * The Obsidian notes of a course (src/server/create-notes.ts) with a SCRIPTED model, scripted PDF seams and
 * throw-away stores: writing the topic notes from cards and pages, the topics that have to go by page headings, a
 * failed or refused call, rewriting one topic, editing, and saving into a vault — never data/*, never the real Claude
 * CLI, never the learner's vault.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { ClaudeAskError, type AskClaude, type AskClaudeRequest } from "../src/agent/claude-ask.ts";
import { HEADING_SYSTEM, TOPIC_SYSTEM, TRIM_SYSTEM } from "../src/agent/create/notes-prompts.ts";
import { CreateInputError, type CardsJob, type LectureSource } from "../src/core/contracts.ts";
import { type CardDraft, DEFAULT_CARD_SETTINGS, type FrontBackCard } from "../src/core/contracts/create-cards.ts";
import type { Box, PageLayout, PageLine } from "../src/core/contracts/page-layout.ts";
import type { LibraryStore } from "../src/core/ports.ts";
import { getNotes, noteFigureFile, type NotesDeps, rewriteTopic, saveToVault, startNotes, updateNote } from "../src/server/create-notes.ts";
import { createCreateStore } from "../src/store/create.ts";
import { createNotesStore } from "../src/store/notes.ts";
import { createStudyStore } from "../src/store/study.ts";
import { createVaultSettings } from "../src/store/vault-settings.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-notes-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const NOW = new Date(2026, 10, 5, 10, 0, 0);
const json = (value: unknown) => ({ text: JSON.stringify(value), costUsd: 0, durationMs: 1 });

const line = (id: string, text: string, bbox: Box, extra: Partial<PageLine> = {}): PageLine => ({ id, text, bbox, tight: null, size: 10, src: "pdf", bold: false, italic: false, underline: false, inFigure: false, ...extra });

/** A page with a title, a sentence, a figure and the caption under it. */
function layoutFor(n: number, title = `Topic ${n}`): PageLayout {
	const lines = [
		line("L1", title, [0.1, 0.05, 0.9, 0.1], { bold: true, size: 20 }),
		line("L2", `Blood backs up into the lungs in case ${n}.`, [0.1, 0.2, 0.9, 0.24]),
		line("L3", `Abb. ${n} The failing heart`, [0.1, 0.91, 0.9, 0.95]),
	];
	return { widthPt: 600, heightPt: 800, lines, figures: [{ id: "F1", kind: "raster", bbox: [0.1, 0.4, 0.9, 0.9] }], legends: [], chars: 80, title };
}

const card = (id: string, page: number, tags: string[], extra: Partial<FrontBackCard> = {}): CardDraft =>
	({ type: "basic", id, page, tier: 2, whyType: "", extra: "", evidence: "", tags, warnings: [], deleted: false, include: true, manual: false, sourceIds: [], sourceBbox: null, image: null, front: `Front ${id}`, back: `Back ${id}`, ...extra }) as CardDraft;

let counter = 0;

interface Script {
	topic?: (req: AskClaudeRequest, topic: string) => unknown;
	heading?: (req: AskClaudeRequest) => unknown;
	trim?: (req: AskClaudeRequest) => unknown;
}

function setup(script: Script = {}) {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const create = createCreateStore(path.join(dir, "create"));
	const study = createStudyStore({ courses: path.join(dir, "courses.jsonl"), cards: path.join(dir, "cards.jsonl"), reviews: path.join(dir, "reviews.jsonl") });
	study.upsertCourse({ id: "cardio", name: "Cardiology", bufferDays: 5, createdAt: NOW.toISOString(), topics: ["Heart failure", "Valves"] });
	const vaultDir = path.join(dir, "vault");
	const pdfDir = path.join(dir, "pdfs");
	fs.mkdirSync(pdfDir, { recursive: true });
	const asked: AskClaudeRequest[] = [];
	const cut: { pdf: string; page: number }[] = [];
	const library: LibraryStore = {
		add: () => {
			throw new Error("not used");
		},
		get: () => null,
		list: (): LectureSource[] => [],
		update: () => null,
		pdfPath: (id) => {
			const file = path.join(pdfDir, `${id}.pdf`);
			if (!fs.existsSync(file) && id !== "gone") fs.writeFileSync(file, `%PDF-1.4 ${id}`);
			return id === "gone" ? null : file;
		},
		remove: () => false,
	};
	const ask: AskClaude = async (req) => {
		asked.push(req);
		if (req.system === TOPIC_SYSTEM) {
			const topic = /Thema: (.*)\n/.exec(req.prompt)![1]!;
			return json(
				script.topic?.(req, topic) ?? {
					markdown: `> [!abstract] Kernaussagen\n> - ${topic} is a core topic (D1 S. 3)\n\n## Details\n- **${topic}** matters (D1 S. 3, D2 S. 4-5)\n\n{{FIG D1_p003_F1 | The failing heart}}\n`,
					tags: ["Heart Failure", "cardiology"],
				},
			);
		}
		if (req.system === HEADING_SYSTEM) return json(script.heading?.(req) ?? { assignments: [] });
		if (req.system === TRIM_SYSTEM) return json(script.trim?.(req) ?? { markdown: "short" });
		throw new Error(`unexpected call: ${req.system.slice(0, 40)}`);
	};
	const deps: NotesDeps = {
		create,
		library,
		study,
		ask,
		renderPage: async () => new Uint8Array(),
		pageLines: async () => [],
		documentText: async () => "",
		addPdf: async () => {
			throw new Error("not used");
		},
		now: () => NOW,
		retryDelayMs: 0,
		openPdf: async () => {
			throw new Error("not used");
		},
		layouts: async (_file, pages) => new Map(pages.map((n) => [n, layoutFor(n, `Page ${n}`)])),
		recognize: async () => [],
		studyMediaDir: path.join(dir, "media"),
		notes: createNotesStore(path.join(dir, "notes")),
		vault: createVaultSettings(path.join(dir, "vault.json"), { home: dir, env: vaultDir }),
		cutFigures: async (pdf, cuts) => {
			for (const c of cuts) cut.push({ pdf, page: c.page });
			return cuts.map((c) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, c.page]));
		},
	};

	/** A finished cards job with the given drafts by page (their layouts kept, as after a real run). */
	function addJob(name: string, pages: Record<number, CardDraft[]>, opts: { lectureId?: string; headings?: Record<string, string> } = {}): string {
		const id = `crt_notes_${++counter}`;
		const job: CardsJob = {
			v: 1,
			id,
			kind: "cards",
			name,
			lectureId: opts.lectureId ?? `lec${counter}`,
			nPages: 9,
			settings: { ...DEFAULT_CARD_SETTINGS, focusTopics: [], focusStrict: false },
			courseId: "cardio",
			state: "done",
			createdAt: new Date(NOW.getTime() + counter * 1000).toISOString(),
			pages: Object.fromEntries(Object.entries(pages).map(([n, cards]) => [n, { status: "done", count: cards.length, adopted: 0 }])),
			...(opts.headings ? { headings: opts.headings } : {}),
		};
		create.createJob(job);
		for (const [n, cards] of Object.entries(pages)) {
			create.writeCardPage(id, { page: Number(n), pageType: "text", skip: false, skipReason: "", topic: "", status: "done", cards, dropped: [] });
			create.writeLayout(id, Number(n), layoutFor(Number(n)));
		}
		return id;
	}
	return { deps, create, study, asked, cut, addJob, vaultDir };
}

/** Waits until the run for the course is over. */
async function settled(courseId: string, deps: NotesDeps): Promise<ReturnType<typeof getNotes>> {
	for (let i = 0; i < 400; i++) {
		const view = getNotes(courseId, deps);
		if (view.run === null && view.status !== "running") return view;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("the run did not finish");
}

describe("starting the notes", () => {
	it("needs topics, and cards assigned to them", () => {
		const { deps, study, addJob } = setup();
		study.upsertCourse({ id: "plain", name: "Plain", bufferDays: 5, createdAt: NOW.toISOString() });
		assert.throws(() => startNotes("plain", deps), (e) => e instanceof CreateInputError && e.status === 400 && /topics/.test(e.message));
		addJob("Lecture", { 3: [card("p003-c01", 3, [])] });
		assert.throws(() => startNotes("cardio", deps), (e) => e instanceof CreateInputError && /Sort the drafts into the topics/.test(e.message));
		assert.throws(() => startNotes("nope", deps), (e) => e instanceof CreateInputError && e.status === 404);
	});

	it("takes only the selected cards that are not thrown away", () => {
		const { deps, addJob } = setup();
		addJob("Lecture", { 3: [card("p003-c01", 3, ["Heart failure"], { include: false }), card("p003-c02", 3, ["Heart failure"], { deleted: true })] });
		assert.throws(() => startNotes("cardio", deps), /Sort the drafts/);
	});
});

describe("writing the topic notes", () => {
	it("writes one note per topic from the cards and the pages, with figures and page links", async () => {
		const { deps, asked, cut, addJob } = setup();
		addJob("01_Heart lecture", { 3: [card("p003-c01", 3, ["Heart failure"]), card("p003-c02", 3, ["Heart failure"])], 5: [card("p005-c01", 5, ["Valves"])] });
		addJob("Valves lecture", { 4: [card("p004-c01", 4, ["Heart failure", "Valves"])] });
		assert.equal(startNotes("cardio", deps), true);
		assert.equal(startNotes("cardio", deps), false, "a run is going already");
		const view = await settled("cardio", deps);

		assert.equal(view.status, "done");
		assert.equal(view.error, "");
		assert.equal(view.name, "Cardiology");
		assert.equal(view.created, "2026-11-05");
		assert.deepEqual(view.sources.map((s) => [s.ref, s.name, s.pdfFile]), [["D1", "01_Heart lecture", "01_Heart lecture.pdf"], ["D2", "Valves lecture", "Valves lecture.pdf"]]);
		assert.deepEqual(view.items.map((i) => [i.id, i.topic, i.kind, i.cards, i.pages, i.refs]), [
			["t01", "Heart failure", "note", 3, 2, ["D1", "D2"]],
			["t02", "Valves", "note", 2, 2, ["D1", "D2"]],
		]);

		const heart = view.items[0]!;
		assert.ok(heart.markdown.includes("[[01_Heart lecture.pdf#page=3|Heart lecture · S. 3]]"), "a source mark became a page link");
		assert.ok(heart.markdown.includes("[[Valves lecture.pdf#page=4|Valves lecture · S. 4–5]]"));
		assert.ok(heart.markdown.includes("![[Heart-failure_D1_p003_F1.png|560]]\n*Abb.: The failing heart*"), "the figure and its caption");
		assert.deepEqual(heart.figures.map((f) => [f.id, f.file, f.src, f.page, f.ref, f.caption]), [["D1_p003_F1", "Heart-failure_D1_p003_F1.png", "figs/D1_p003_F1.png", 3, "D1", "The failing heart"]]);
		assert.deepEqual(heart.tags, ["heart-failure", "cardiology"]);
		assert.equal(heart.include, true);
		assert.ok(heart.words > 0);
		assert.ok(fs.existsSync(path.join(path.dirname(deps.notes.figsDir("cardio")), "figs/D1_p003_F1.png")), "the figure was cut out and kept");
		assert.ok(cut.length > 0);
		assert.ok(deps.notes.read("cardio")?.items.length === 2, "the note set is stored");

		const topicCalls = asked.filter((r) => r.system === TOPIC_SYSTEM);
		assert.equal(topicCalls.length, 2);
		assert.ok(topicCalls.every((r) => r.model === "sonnet"));
		const prompt = topicCalls.find((r) => r.prompt.includes("Thema: Heart failure"))!.prompt;
		assert.ok(prompt.includes("Fach: Cardiology"));
		assert.ok(prompt.includes("=== D1 · S. 3 ===\n"), "the pages as sources");
		assert.ok(prompt.includes("=== D2 · S. 4 ==="));
		assert.ok(prompt.includes("[FIG D1_p003_F1] D1 · S. 3, Bildunterschrift im Skript: „Abb. 3 The failing heart“ — Bilddatei: figs/D1_p003_F1.png"));
		assert.ok(prompt.includes("- Front p003-c01 – Back p003-c01"), "the cards as facts to keep");
		assert.equal(topicCalls[0]!.cwd, path.dirname(deps.notes.figsDir("cardio")), "Claude runs where the figures lie");
	});

	it("shortens a note that is far over its word budget, with the small model", async () => {
		const long = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
		const { deps, asked, addJob } = setup({ topic: () => ({ markdown: `${long} (D1 S. 3)` }), trim: () => ({ markdown: "A short note (D1 S. 3)" }) });
		addJob("Lecture", { 3: [card("p003-c01", 3, ["Heart failure"])] });
		startNotes("cardio", deps);
		const view = await settled("cardio", deps);
		const trims = asked.filter((r) => r.system === TRIM_SYSTEM);
		assert.equal(trims.length, 1);
		assert.equal(trims[0]!.model, "haiku");
		assert.ok(view.items[0]!.markdown.startsWith("A short note"));
	});

	it("keeps the long note when the shortening fails", async () => {
		const long = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
		const ask = { n: 0 };
		const { deps, addJob } = setup({
			topic: () => ({ markdown: long }),
			trim: () => {
				ask.n++;
				throw new ClaudeAskError("boom", "other");
			},
		});
		addJob("Lecture", { 3: [card("p003-c01", 3, ["Heart failure"])] });
		startNotes("cardio", deps);
		const view = await settled("cardio", deps);
		assert.equal(view.items[0]!.kind, "note");
		assert.ok(view.items[0]!.markdown.includes("word899"));
	});

	it("finds the pages of a topic without a card by the headings of the pages", async () => {
		const { deps, asked, addJob } = setup({
			heading: (req) => ({ assignments: [{ id: /(crt_notes_\d+:6)/.exec(req.prompt)![1], topic: 1 }] }),
		});
		addJob("Lecture", { 3: [card("p003-c01", 3, ["Heart failure"])], 6: [] }, { headings: { "3": "Heart failure", "6": "Aortic valve stenosis" } });
		startNotes("cardio", deps);
		const view = await settled("cardio", deps);
		assert.deepEqual(view.items.map((i) => [i.topic, i.kind, i.cards, i.pages]), [["Heart failure", "note", 1, 1], ["Valves", "note", 0, 1]]);
		const headingCall = asked.find((r) => r.system === HEADING_SYSTEM)!;
		assert.equal(headingCall.model, "haiku");
		assert.ok(headingCall.prompt.includes("Themen des Fachs (Nummer):\n1. Valves\n"), "only the topics without a card are matched");
		const valvesPrompt = asked.find((r) => r.system === TOPIC_SYSTEM && r.prompt.includes("Thema: Valves"))!.prompt;
		assert.ok(valvesPrompt.includes("=== D1 · S. 6 ==="), "the page found by its heading");
		assert.ok(valvesPrompt.includes("Lernkarten zu diesem Thema (geprüfte Prüfungsfakten – alle wichtigen Inhalte übernehmen):\n(keine)"));
	});

	it("skips a topic with neither a card nor a page", async () => {
		const { deps, addJob } = setup();
		addJob("Lecture", { 3: [card("p003-c01", 3, ["Heart failure"])] });
		startNotes("cardio", deps);
		const view = await settled("cardio", deps);
		assert.deepEqual(view.items.map((i) => [i.topic, i.kind]), [["Heart failure", "note"], ["Valves", "skipped"]]);
		assert.match(view.items[1]!.skipReason, /No cards are assigned/);
	});

	it("lets one failed note be one failed note", async () => {
		const { deps, addJob } = setup({
			topic: (_req, topic) => {
				if (topic === "Valves") throw new ClaudeAskError("The model fell over", "other");
				return { markdown: "A note (D1 S. 3)" };
			},
		});
		addJob("Lecture", { 3: [card("p003-c01", 3, ["Heart failure"]), card("p003-c02", 3, ["Valves"])] });
		startNotes("cardio", deps);
		const view = await settled("cardio", deps);
		assert.equal(view.status, "done");
		assert.deepEqual(view.items.map((i) => [i.topic, i.kind]), [["Heart failure", "note"], ["Valves", "error"]]);
		assert.match(view.items[1]!.error, /fell over/);
	});

	it("stops when Claude is not available and says what was not written", async () => {
		const { deps, addJob } = setup({
			topic: () => {
				throw new ClaudeAskError("Not signed in", "auth");
			},
		});
		addJob("Lecture", { 3: [card("p003-c01", 3, ["Heart failure"]), card("p003-c02", 3, ["Valves"])] });
		startNotes("cardio", deps);
		const view = await settled("cardio", deps);
		assert.equal(view.status, "error");
		assert.match(view.error, /Claude is not available: Not signed in/);
		assert.ok(view.items.every((i) => i.kind === "error" && /not written/.test(i.error)));
	});

	it("reads a note when the PDF is gone from the library but the layout was kept; fails honestly when it is not", async () => {
		const { deps, addJob } = setup();
		addJob("Lecture", { 3: [card("p003-c01", 3, ["Heart failure"])], 5: [card("p005-c01", 5, ["Valves"])] }, { lectureId: "gone" });
		startNotes("cardio", deps);
		const view = await settled("cardio", deps);
		assert.deepEqual(view.items.map((i) => i.kind), ["note", "note"]);
		assert.deepEqual(view.items[0]!.figures, [], "no PDF, no figures — but a note");
	});

	it("reports a run that is gone after a restart as interrupted", () => {
		const { deps } = setup();
		deps.notes.update("cardio", (d) => Object.assign(d, { status: "running", items: [{ id: "t01", ix: 1, topic: "Heart failure", kind: "pending", skipReason: "", cards: 1, pages: 0, refs: [], markdown: "", words: 0, figures: [], include: true, error: "" }], sources: [] }));
		const view = getNotes("cardio", deps);
		assert.equal(view.status, "error");
		assert.match(view.error, /interrupted/);
		assert.equal(view.items[0]!.kind, "error");
	});
});

describe("working with the note set", () => {
	async function written() {
		const s = setup();
		s.addJob("Lecture", { 3: [card("p003-c01", 3, ["Heart failure"])], 5: [card("p005-c01", 5, ["Valves"])] });
		startNotes("cardio", s.deps);
		await settled("cardio", s.deps);
		return s;
	}

	it("rewrites one topic, from the sources of the note set, leaving the others", async () => {
		const s = await written();
		const before = getNotes("cardio", s.deps).items;
		s.asked.length = 0;
		assert.equal(rewriteTopic("cardio", "t02", s.deps), true);
		const view = await settled("cardio", s.deps);
		assert.equal(view.status, "done");
		assert.deepEqual(view.items[0], before[0], "the other topic is as it was");
		assert.equal(s.asked.filter((r) => r.system === TOPIC_SYSTEM).length, 1);
		assert.throws(() => rewriteTopic("cardio", "t09", s.deps), (e) => e instanceof CreateInputError && e.status === 404);
	});

	it("takes the learner's edit of a note and of whether it goes into the vault", async () => {
		const s = await written();
		const edited = updateNote("cardio", "t01", { markdown: "Own words about the heart.\r\nSecond line.  \n\n" }, s.deps);
		assert.equal(edited.markdown, "Own words about the heart.\nSecond line.\n");
		assert.equal(edited.words, 7);
		assert.equal(updateNote("cardio", "t01", { include: false }, s.deps).include, false);
		assert.equal(getNotes("cardio", s.deps).items[0]!.include, false);
		assert.throws(() => updateNote("cardio", "t01", { markdown: 7 }, s.deps), /must be text/);
		assert.throws(() => updateNote("cardio", "t01", { include: "no" }, s.deps), /true or false/);
		assert.throws(() => updateNote("cardio", "t99", { include: true }, s.deps), (e) => e instanceof CreateInputError && e.status === 404);
	});

	it("will not edit a note that was never written", async () => {
		const s = setup();
		s.addJob("Lecture", { 3: [card("p003-c01", 3, ["Heart failure"])] });
		startNotes("cardio", s.deps);
		await settled("cardio", s.deps);
		assert.throws(() => updateNote("cardio", "t02", { include: true }, s.deps), /not been written/);
	});

	it("serves only the figures of the note set, by their file name", async () => {
		const s = await written();
		const f = noteFigureFile("cardio", "Heart-failure_D1_p003_F1.png", s.deps);
		assert.equal(f.type, "image/png");
		assert.ok(fs.existsSync(f.file));
		assert.throws(() => noteFigureFile("cardio", "../../etc/passwd", s.deps), (e) => e instanceof CreateInputError && e.status === 404);
		assert.throws(() => noteFigureFile("cardio", "nope.png", s.deps), (e) => e instanceof CreateInputError && e.status === 404);
	});
});

describe("saving into the vault", () => {
	async function written(extra: (s: ReturnType<typeof setup>) => void = () => undefined) {
		const s = setup();
		extra(s);
		s.addJob("Lecture", { 3: [card("p003-c01", 3, ["Heart failure"])], 5: [card("p005-c01", 5, ["Valves"])] });
		startNotes("cardio", s.deps);
		await settled("cardio", s.deps);
		return s;
	}

	it("writes the selected notes, the overview, the PDF and the figure into the vault", async () => {
		const s = await written();
		updateNote("cardio", "t02", { include: false }, s.deps);
		const saved = saveToVault("cardio", s.deps);
		assert.equal(saved.count, 1);
		assert.equal(saved.created, true);
		assert.equal(saved.vault, s.vaultDir);
		assert.equal(saved.path, path.join(s.vaultDir, "Cardiology/Themen/00 Übersicht.md"));
		assert.equal(saved.url, `obsidian://open?path=${encodeURIComponent(saved.path)}`);
		assert.equal(saved.at, "2026-11-05");
		const note = fs.readFileSync(path.join(s.vaultDir, "Cardiology/Themen/Heart failure.md"), "utf8");
		assert.ok(note.startsWith('---\nfach: "Cardiology"\nthema: "Heart failure"\nquellen:\n  - "[[Lecture.pdf]]"\ntags:\n  - medizinstudium\n  - cardiology\n  - heart-failure\nerstellt: 2026-11-05\nmedanki_id: cardio-Heart-failure\n---\n'));
		assert.ok(note.includes("[[Cardiology/Themen/00 Übersicht|↑ Cardiology · Themen]]"));
		assert.ok(note.endsWith("## Eigene Notizen\n\n"));
		assert.equal(fs.existsSync(path.join(s.vaultDir, "Cardiology/Themen/Valves.md")), false, "a note that is not selected stays out");
		assert.ok(fs.existsSync(path.join(s.vaultDir, "Files/Cardiology/Lecture.pdf")));
		assert.ok(fs.existsSync(path.join(s.vaultDir, "Files/Cardiology/Heart-failure_D1_p003_F1.png")));
		assert.deepEqual(getNotes("cardio", s.deps).saved, saved, "where it was saved is kept");
	});

	it("keeps what the reader wrote under 'Eigene Notizen' when the notes are saved again", async () => {
		const s = await written();
		saveToVault("cardio", s.deps);
		const file = path.join(s.vaultDir, "Cardiology/Themen/Heart failure.md");
		fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}My own thought.\n`);
		updateNote("cardio", "t01", { markdown: "Revised text.\n" }, s.deps);
		const saved = saveToVault("cardio", s.deps);
		assert.equal(saved.created, false);
		const note = fs.readFileSync(file, "utf8");
		assert.ok(note.includes("Revised text."));
		assert.ok(note.endsWith("## Eigene Notizen\n\nMy own thought.\n"));
	});

	it("names a note after the course's vault key when it has one, so notes already in the vault are updated", async () => {
		const s = await written((x) => x.study.upsertCourse({ id: "cardio", name: "Cardiology", bufferDays: 5, createdAt: NOW.toISOString(), topics: ["Heart failure", "Valves"], vaultKey: "old-medanki-id" }));
		saveToVault("cardio", s.deps);
		assert.ok(fs.readFileSync(path.join(s.vaultDir, "Cardiology/Themen/Heart failure.md"), "utf8").includes("medanki_id: old-medanki-id-Heart-failure\n"));
	});

	it("says how many notes it left alone because their structure was edited", async () => {
		const s = await written();
		saveToVault("cardio", s.deps);
		const file = path.join(s.vaultDir, "Cardiology/Themen/Heart failure.md");
		fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("## Eigene Notizen", "## Mein Bereich"));
		assert.equal(saveToVault("cardio", s.deps).skipped, 1);
	});

	it("refuses when there is nothing to save, and says why", async () => {
		const s = setup();
		s.addJob("Lecture", { 3: [card("p003-c01", 3, ["Heart failure"])] });
		assert.throws(() => saveToVault("cardio", s.deps), /no finished topic notes/);
		startNotes("cardio", s.deps);
		await settled("cardio", s.deps);
		updateNote("cardio", "t01", { include: false }, s.deps);
		assert.throws(() => saveToVault("cardio", s.deps), /No topic note is selected/);
	});

	it("refuses when a PDF the notes link to is gone, rather than writing dead links", async () => {
		const s = await written();
		s.create.update(s.create.list()[0]!.id, (j) => {
			j.lectureId = "gone";
		});
		assert.throws(() => saveToVault("cardio", s.deps), (e) => e instanceof CreateInputError && e.status === 409 && /no longer in the library/.test(e.message));
	});
});
