/**
 * The cards runner (src/server/create-cards.ts) end to end with a SCRIPTED model, a fake PDF session and fake
 * page layouts: a throw-away create store, study store and library — never data/*, never the real Claude
 * CLI or a real PDF engine.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { ClaudeAskError, type AskClaude, type AskClaudeRequest } from "../src/agent/claude-ask.ts";
import type { PdfSession } from "../src/agent/create/card-media.ts";
import { CRITIC_SYSTEM } from "../src/agent/create/card-prompts.ts";
import { CreateInputError, type LectureSource } from "../src/core/contracts.ts";
import type { FrontBackCard } from "../src/core/contracts/create-cards.ts";
import type { Box, PageLayout, PageLine } from "../src/core/contracts/page-layout.ts";
import type { LibraryStore } from "../src/core/ports.ts";
import {
	adoptCards,
	cardMediaFile,
	createCardsJob,
	finalizeDuplicates,
	getCardsJob,
	setCardDeleted,
	startCardsJob,
	type CardsDeps,
} from "../src/server/create-cards.ts";
import { createMcqJob, getCreateJob, startCreateJob, stopCreateJob } from "../src/server/create.ts";
import { createCreateStore } from "../src/store/create.ts";
import { createStudyStore } from "../src/store/study.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-cards-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const NOW = new Date(2026, 10, 4, 10, 0, 0);

function line(id: string, text: string, bbox: Box, extra: Partial<PageLine> = {}): PageLine {
	return { id, text, bbox, tight: null, size: 10, src: "pdf", bold: false, italic: false, underline: false, inFigure: false, ...extra };
}

/** Page n: a title, sentences the cards can quote, and a picture the image cards can point at. */
function layoutFor(n: number): PageLayout {
	const lines = [
		line("L1", `Topic ${n}`, [0.1, 0.05, 0.9, 0.1], { bold: true, size: 20 }),
		line("L2", `Blood backs up into the lungs in case ${n}.`, [0.1, 0.2, 0.9, 0.24]),
		// long enough for the evidence check (it skips pages with hardly any text)
		line("L3", "The heart pumps blood through the body while the valves keep the flow in one direction during every beat of the cycle.", [0.1, 0.26, 0.9, 0.3]),
	];
	return {
		widthPt: 600,
		heightPt: 800,
		lines,
		figures: [{ id: "F1", kind: "raster", bbox: [0.1, 0.4, 0.9, 0.9] }],
		legends: [],
		chars: lines.reduce((sum, l) => sum + l.text.length, 0),
		title: `Topic ${n}`,
	};
}

function fakeSession(log: { regions: number[] } = { regions: [] }): PdfSession {
	return {
		numPages: 99,
		renderPage: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
		renderRegion: async (page) => {
			log.regions.push(page);
			const width = 40;
			const height = 30;
			const data = new Uint8ClampedArray(width * height * 4);
			for (let i = 0; i < data.length; i += 4) {
				data[i] = 200;
				data[i + 1] = 120;
				data[i + 2] = 60;
				data[i + 3] = 255;
			}
			return { width, height, data };
		},
		close: async () => undefined,
	};
}

function fakeLibrary(dir: string, entries: Record<string, { title: string; pages: number }>): LibraryStore {
	const sources = (): LectureSource[] =>
		Object.entries(entries).map(([id, e]) => ({
			v: 1,
			id,
			title: e.title,
			fileName: `${e.title}.pdf`,
			bytes: 10,
			sha256: id,
			pages: e.pages,
			addedAt: NOW.toISOString(),
			status: "stored",
		}));
	return {
		add: () => {
			throw new Error("not used");
		},
		get: (id) => sources().find((s) => s.id === id) ?? null,
		list: sources,
		update: () => null,
		pdfPath: (id) => (entries[id] ? path.join(dir, `${id}.pdf`) : null),
		remove: () => false,
	};
}

const pageOf = (req: AskClaudeRequest): number => Number(/Seite (\d+) von/.exec(req.prompt)?.[1]);
const isGlossary = (req: AskClaudeRequest) => req.model === "haiku";
const isCritic = (req: AskClaudeRequest) => req.system === CRITIC_SYSTEM;

const STRUCTURES = ["", "the aorta", "the vena cava", "the pulmonary vein", "the coronary sinus"];

/** A well-formed answer for page n: one card of its own, one more that is the same on every page. */
function pageAnswer(n: number): string {
	return JSON.stringify({
		page_type: "text",
		topic: `Topic ${n}`,
		cards: [
			{
				type: "basic",
				priority: 1,
				front: `Which vessel does ${STRUCTURES[n]} drain into on page ${n}?`,
				back: `The right atrium (case ${n}).`,
				evidence: "Blood backs up into the lungs",
				source: ["L2"],
			},
			{
				type: "basic",
				priority: 2,
				front: "Where does the blood back up in left heart failure?",
				back: "Into the lungs.",
				evidence: "Blood backs up into the lungs",
				source: ["L2"],
			},
		],
	});
}

const scripted: AskClaude = async (req) => {
	if (isGlossary(req)) return { text: JSON.stringify({ terms: [{ canonical: "Pulmonary congestion", variants: ["lung congestion"] }] }), costUsd: 0, durationMs: 1 };
	if (isCritic(req)) return { text: JSON.stringify({ cards: [] }), costUsd: 0, durationMs: 1 };
	return { text: pageAnswer(pageOf(req)), costUsd: 0, durationMs: 1 };
};

function setup(over: Partial<CardsDeps> = {}, pages = 3, title = "Cardiology") {
	const { ask = scripted, ...rest } = over;
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const create = createCreateStore(path.join(dir, "create"));
	const study = createStudyStore({
		courses: path.join(dir, "courses.jsonl"),
		cards: path.join(dir, "cards.jsonl"),
		reviews: path.join(dir, "reviews.jsonl"),
	});
	study.upsertCourse({ id: "cardio", name: "Cardiology", bufferDays: 5, createdAt: NOW.toISOString() });
	const asked: AskClaudeRequest[] = [];
	const layoutCalls: number[][] = [];
	const regions: number[] = [];
	const studyMediaDir = path.join(dir, "study-media");
	const deps: CardsDeps = {
		create,
		library: fakeLibrary(dir, { lec1: { title, pages } }),
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
		openPdf: async () => fakeSession({ regions }),
		layouts: async (_file, pageList) => {
			layoutCalls.push([...pageList]);
			return new Map(pageList.map((n) => [n, layoutFor(n)]));
		},
		recognize: async () => [],
		studyMediaDir,
		...rest,
	};
	return { deps, create, study, asked, layoutCalls, regions, studyMediaDir };
}

async function runJob(deps: CardsDeps, settings: object = {}) {
	const summary = await createCardsJob({ lectureId: "lec1", settings, autostart: false }, deps);
	await startCardsJob(summary.id, {}, deps).settled;
	return summary.id;
}

const frontsOf = (deps: CardsDeps, id: string, page: number) =>
	(getCardsJob(id, deps).pages.find((p) => p.page === page)?.cards ?? []).filter((c) => !c.deleted).map((c) => (c as FrontBackCard).front);

describe("creating a cards job", () => {
	it("names the job after the PDF and plans one pending page per page of the range", async () => {
		const { deps } = setup();
		const job = await createCardsJob({ lectureId: "lec1", settings: { pageFrom: 2, pageTo: 99 }, autostart: false }, deps);
		assert.equal(job.name, "Cardiology");
		assert.equal(job.kind, "cards");
		assert.equal(job.state, "queued");
		assert.equal(job.total, 2);
		const detail = getCardsJob(job.id, deps);
		assert.deepEqual(detail.pages.map((p) => [p.page, p.status]), [[2, "pending"], [3, "pending"]]);
		assert.equal(detail.settings.pageTo, 3);
		assert.equal(detail.settings.language, "en");
	});

	it("refuses an unknown PDF and a backwards range, and keeps the two job kinds apart", async () => {
		const { deps } = setup();
		await assert.rejects(createCardsJob({ lectureId: "nope" }, deps), (e) => e instanceof CreateInputError && e.status === 404);
		await assert.rejects(createCardsJob({ lectureId: "lec1", settings: { pageFrom: 3, pageTo: 2 } }, deps), (e) => e instanceof CreateInputError && e.status === 400);
		const cards = await createCardsJob({ lectureId: "lec1", autostart: false }, deps);
		const mcq = await createMcqJob({ lectureId: "lec1", autostart: false }, deps);
		assert.throws(() => getCreateJob(cards.id, deps), (e) => e instanceof CreateInputError && e.status === 409);
		assert.throws(() => getCardsJob(mcq.id, deps), (e) => e instanceof CreateInputError && e.status === 409);
		assert.throws(() => adoptCards(mcq.id, { courseId: "cardio" }, deps), (e) => e instanceof CreateInputError && e.status === 409);
	});
});

describe("running a cards job", () => {
	it("makes draft cards for every page, with the run-level preparation done once", async () => {
		const { deps, asked, layoutCalls } = setup();
		const id = await runJob(deps);
		const detail = getCardsJob(id, deps);
		assert.equal(detail.job.state, "done");
		assert.deepEqual(detail.job.counts, { pending: 0, running: 0, done: 3, error: 0 });
		assert.deepEqual(detail.pages.map((p) => p.topic), ["Topic 1", "Topic 2", "Topic 3"]);
		assert.equal(frontsOf(deps, id, 2)[0], "Which vessel does the vena cava drain into on page 2?");
		assert.ok(detail.pages.every((p) => p.cards.length >= 1 && p.cards.every((c) => c.id.startsWith(`p00${p.page}-c`))));

		// the glossary is asked once (on the fast model), the pages are read once each
		assert.equal(asked.filter(isGlossary).length, 1);
		assert.equal(asked.filter((r) => !isGlossary(r) && !isCritic(r)).length, 3);
		const job = deps.create.get(id)!;
		assert.equal(job.kind === "cards" && job.glossary?.[0]?.canonical, "Pulmonary congestion");
		assert.equal(job.kind === "cards" && job.headings?.["2"], "Topic 2");
		assert.equal(job.kind === "cards" && job.latin, false);
		assert.deepEqual(layoutCalls.flat().filter((n) => n === 2).length >= 1, true);

		// the page prompt names the document, the page and the neighbours; the glossary rides in the system prompt
		const page2 = asked.find((r) => pageOf(r) === 2)!;
		assert.match(page2.prompt, /Dokument: Cardiology — Seite 2 von 3/);
		assert.match(page2.prompt, /Vorherige Seite: "Topic 1"/);
		assert.match(page2.system, /Pulmonary congestion/);
		assert.ok(fs.existsSync(path.join(deps.create.workDir(id), "pages", "p002.png")));
	});

	it("switches the Latin terms on for an anatomy PDF", async () => {
		const { deps } = setup({}, 1, "Anatomie des Herzens");
		const id = await runJob(deps);
		const job = deps.create.get(id)!;
		assert.equal(job.kind === "cards" && job.latin, true);
	});

	it("throws practically identical cards of different pages away at the end (soft, restorable)", async () => {
		const { deps } = setup();
		const id = await runJob(deps);
		const all = getCardsJob(id, deps).pages.flatMap((p) => p.cards);
		const duplicates = all.filter((c) => c.deleted);
		assert.ok(duplicates.length >= 1, "the same question on three pages leaves only one");
		assert.ok(duplicates.every((c) => /duplicate/i.test(c.note ?? "")));
		assert.equal(finalizeDuplicates(id, deps), 0, "a second pass finds nothing more");
		const back = setCardDeleted(id, duplicates[0]!.id, false, deps);
		assert.equal(back.deleted, false);
		assert.equal(back.restored, true);
		finalizeDuplicates(id, deps);
		const restored = getCardsJob(id, deps).pages.flatMap((p) => p.cards).find((c) => c.id === back.id)!;
		assert.equal(restored.deleted, false, "a restored card is never thrown away again");
	});

	it("gives a flagged card to the critic and applies its verdict", async () => {
		const flagged = JSON.stringify({
			topic: "Topic 1",
			cards: [
				{ type: "basic", priority: 2, front: "What is the answer?", back: "Something.", evidence: "this is not on the page", source: ["L2"] },
				{ type: "basic", priority: 2, front: "Where does blood back up?", back: "Into the lungs.", evidence: "Blood backs up into the lungs", source: ["L2"] },
			],
		});
		const { deps, asked } = setup({
			ask: async (req) => {
				if (isGlossary(req)) return { text: JSON.stringify({ terms: [] }), costUsd: 0, durationMs: 1 };
				if (isCritic(req)) return { text: JSON.stringify({ cards: [{ id: "p001-c01", verdict: "delete", reason: "Not on the page" }] }), costUsd: 0, durationMs: 1 };
				return { text: flagged, costUsd: 0, durationMs: 1 };
			},
		}, 1);
		const id = await runJob(deps);
		assert.equal(asked.filter(isCritic).length, 1);
		const [bad, good] = getCardsJob(id, deps).pages[0]!.cards;
		assert.equal(bad!.deleted, true);
		assert.equal(bad!.note, "Critic: Not on the page");
		assert.equal(good!.deleted, false);
	});

	it("survives a failed critic or glossary call", async () => {
		const { deps } = setup({
			ask: async (req) => {
				if (isGlossary(req) || isCritic(req)) throw new ClaudeAskError("boom", "other");
				return { text: pageAnswer(pageOf(req)), costUsd: 0, durationMs: 1 };
			},
		}, 2);
		const id = await runJob(deps);
		assert.equal(getCardsJob(id, deps).job.state, "done");
		const job = deps.create.get(id)!;
		assert.deepEqual(job.kind === "cards" && job.glossary, []);
	});

	it("marks a page whose answer cannot be read as an error and finishes the others", async () => {
		const { deps } = setup({
			ask: async (req) => {
				if (isGlossary(req)) return { text: JSON.stringify({ terms: [] }), costUsd: 0, durationMs: 1 };
				if (pageOf(req) === 2) return { text: "no json at all", costUsd: 0, durationMs: 1 };
				return { text: pageAnswer(pageOf(req)), costUsd: 0, durationMs: 1 };
			},
		});
		const id = await runJob(deps);
		const detail = getCardsJob(id, deps);
		assert.deepEqual(detail.pages.map((p) => p.status), ["done", "error", "done"]);
		assert.match(detail.pages[1]!.error ?? "", /JSON/i);
		assert.equal(detail.job.state, "done");
	});

	it("stops the whole run when the sign-in is gone and says why", async () => {
		const { deps } = setup({
			ask: async () => {
				throw new ClaudeAskError("Not signed in — run /login", "auth");
			},
		});
		const id = await runJob(deps);
		const detail = getCardsJob(id, deps);
		assert.equal(detail.job.state, "stopped");
		assert.match(detail.job.blocked ?? "", /signed in/);
		assert.ok(detail.pages.every((p) => p.status === "pending"));
	});

	it("resumes only the unfinished pages", async () => {
		let fail = true;
		const { deps, asked } = setup({
			ask: async (req) => {
				if (isGlossary(req)) return { text: JSON.stringify({ terms: [] }), costUsd: 0, durationMs: 1 };
				if (pageOf(req) === 2 && fail) return { text: "no json", costUsd: 0, durationMs: 1 };
				return { text: pageAnswer(pageOf(req)), costUsd: 0, durationMs: 1 };
			},
		});
		const id = await runJob(deps);
		fail = false;
		asked.length = 0;
		await startCardsJob(id, {}, deps).settled;
		assert.deepEqual(asked.filter((r) => !isGlossary(r) && !isCritic(r)).map(pageOf), [2]);
		assert.equal(getCardsJob(id, deps).job.counts.done, 3);
		assert.equal(startCardsJob(id, {}, deps).started, false, "nothing left to do");
	});

	it("goes through the start route's dispatch and can be stopped", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const { deps } = setup({
			ask: async (req) => {
				if (isGlossary(req)) return { text: JSON.stringify({ terms: [] }), costUsd: 0, durationMs: 1 };
				await gate;
				return { text: pageAnswer(pageOf(req)), costUsd: 0, durationMs: 1 };
			},
		}, 3);
		const summary = await createCardsJob({ lectureId: "lec1", autostart: false, settings: { concurrency: 1 } }, deps);
		const run = startCreateJob(summary.id, {}, deps);
		assert.equal(run.started, true);
		assert.equal(startCreateJob(summary.id, {}, deps).started, false, "a run is already going");
		assert.equal(stopCreateJob(summary.id), true);
		release();
		await run.settled;
		const detail = getCardsJob(summary.id, deps);
		assert.equal(detail.job.state, "stopped");
		assert.ok(detail.pages.every((p) => p.status !== "running"));
	});
});

describe("running a page again", () => {
	it("keeps the learner's own and the adopted cards with their ids and numbers the fresh ones after them", async () => {
		const { deps, create } = setup({}, 1);
		const id = await runJob(deps);
		const first = create.readCardPage(id, 1)!;
		const [a, b] = first.cards as FrontBackCard[];
		a!.manual = true; // the learner's own
		create.writeCardPage(id, first);
		assert.equal(adoptCards(id, { courseId: "cardio", cardIds: [b!.id] }, deps).adopted, 1);

		await startCardsJob(id, { pages: [1] }, deps).settled;
		const again = create.readCardPage(id, 1)!;
		const ids = again.cards.map((c) => c.id);
		assert.ok(ids.includes(a!.id) && ids.includes(b!.id), "both kept");
		assert.equal(new Set(ids).size, ids.length, "no id twice");
		assert.ok(again.cards.find((c) => c.id === b!.id)!.adopted, "still marked as adopted");
		const fresh = again.cards.filter((c) => c.id !== a!.id && c.id !== b!.id);
		assert.ok(fresh.length >= 1);
		assert.ok(fresh.every((c) => Number(/-c(\d+)$/.exec(c.id)![1]) > 2), "fresh cards come after the kept ones");
	});
});

describe("adopting cards", () => {
	it("makes study cards of the course, once, with the pictures copied", async () => {
		const withImage = JSON.stringify({
			topic: "Topic 1",
			cards: [
				{ type: "basic", priority: 1, front: "Where does blood back up?", back: "Into the lungs.", evidence: "Blood backs up into the lungs", source: ["L2"] },
				{
					type: "image_question",
					priority: 1,
					front: "What does this figure show?",
					back: "The lungs.",
					image: { ref: "F1" },
					evidence: "Blood backs up into the lungs",
					source: ["L2"],
				},
			],
		});
		const { deps, study, studyMediaDir } = setup({
			ask: async (req) => {
				if (isGlossary(req)) return { text: JSON.stringify({ terms: [] }), costUsd: 0, durationMs: 1 };
				return { text: withImage, costUsd: 0, durationMs: 1 };
			},
		}, 1);
		const id = await runJob(deps);
		const cards = getCardsJob(id, deps).pages[0]!.cards;
		assert.equal(cards.length, 2);

		const result = adoptCards(id, { courseId: "cardio" }, deps);
		assert.deepEqual(result, { adopted: 2, skipped: 0 });
		const made = study.readCards().filter((c) => c.courseId === "cardio");
		assert.equal(made.length, 2);
		assert.ok(made.every((c) => c.id.startsWith(`crt_${id}_`) && c.origin.kind === "pdf"));
		const media = fs.readdirSync(studyMediaDir);
		assert.ok(media.some((f) => f.startsWith("img_")), "the context picture reached the study media folder");

		// the list can fetch the picture of a draft, and nothing else
		const picture = cards.map((c) => (c as FrontBackCard).image?.file).find(Boolean)!;
		assert.ok(picture, "the picture question has its context picture");
		const served = cardMediaFile(id, picture, deps);
		assert.equal(served.file, path.join(deps.create.mediaDir(id), picture));
		assert.match(served.type, /^image\/(png|jpeg)$/);
		for (const bad of ["../job.json", "job.json", ".hidden.png", "nope.png", "a/b.png"]) {
			assert.throws(() => cardMediaFile(id, bad, deps), (e) => e instanceof CreateInputError && e.status === 404, bad);
		}

		// adopting again changes nothing
		assert.deepEqual(adoptCards(id, { courseId: "cardio" }, deps), { adopted: 0, skipped: 2 });
		assert.equal(study.readCards().filter((c) => c.courseId === "cardio").length, 2);
		assert.equal(getCardsJob(id, deps).job.adopted, 2);

		// an adopted card is a study card now
		assert.throws(() => setCardDeleted(id, cards[0]!.id, true, deps), (e) => e instanceof CreateInputError && e.status === 409);
		assert.throws(() => adoptCards(id, { courseId: "nope" }, deps), (e) => e instanceof CreateInputError && e.status === 404);
	});

	it("leaves deleted drafts out and adopts just the named ones", async () => {
		const { deps, study } = setup({}, 2);
		const id = await runJob(deps);
		const cards = getCardsJob(id, deps).pages.flatMap((p) => p.cards).filter((c) => !c.deleted);
		assert.ok(cards.length >= 2);
		const [one, two] = cards;
		setCardDeleted(id, two!.id, true, deps);
		assert.equal(setCardDeleted(id, two!.id, true, deps).deleted, true);
		assert.deepEqual(adoptCards(id, { courseId: "cardio", cardIds: [one!.id, two!.id] }, deps), { adopted: 1, skipped: 1 });
		assert.equal(study.readCards().length, 1);
		assert.throws(() => setCardDeleted(id, "p009-c01", true, deps), (e) => e instanceof CreateInputError && e.status === 404);
		assert.throws(() => setCardDeleted(id, "../x", true, deps), (e) => e instanceof CreateInputError && e.status === 404);
	});
});
