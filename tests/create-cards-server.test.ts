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
import { CRITIC_SYSTEM, DEDUPE_SYSTEM } from "../src/agent/create/card-prompts.ts";
import { CreateInputError, type LectureSource } from "../src/core/contracts.ts";
import type { FrontBackCard, OcclusionCard } from "../src/core/contracts/create-cards.ts";
import type { Box, PageLayout, PageLine } from "../src/core/contracts/page-layout.ts";
import type { LibraryStore } from "../src/core/ports.ts";
import {
	adoptCards,
	cardMediaFile,
	createCardsJob,
	finalizeDuplicates,
	getCardsJob,
	startCardsJob,
	type CardsDeps,
} from "../src/server/create-cards.ts";
import {
	addManualCard,
	editImage,
	editMask,
	pageImageFile,
	patchCard,
	removeDuplicates,
	reviewDuplicates,
	semanticDedupeStep,
	semanticGroups,
	setFocus,
	setInclude,
} from "../src/server/create-cards-edit.ts";
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
		const back = patchCard(id, duplicates[0]!.id, { deleted: false }, deps);
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
		assert.throws(() => patchCard(id, cards[0]!.id, { deleted: true }, deps), (e) => e instanceof CreateInputError && e.status === 409);
		assert.throws(() => adoptCards(id, { courseId: "nope" }, deps), (e) => e instanceof CreateInputError && e.status === 404);
	});

	it("leaves deleted drafts out and adopts just the named ones", async () => {
		const { deps, study } = setup({}, 2);
		const id = await runJob(deps);
		const cards = getCardsJob(id, deps).pages.flatMap((p) => p.cards).filter((c) => !c.deleted);
		assert.ok(cards.length >= 2);
		const [one, two] = cards;
		patchCard(id, two!.id, { deleted: true }, deps);
		assert.equal(patchCard(id, two!.id, { deleted: true }, deps).deleted, true);
		assert.deepEqual(adoptCards(id, { courseId: "cardio", cardIds: [one!.id, two!.id] }, deps), { adopted: 1, skipped: 1 });
		assert.equal(study.readCards().length, 1);
		assert.throws(() => patchCard(id, "p009-c01", { deleted: true }, deps), (e) => e instanceof CreateInputError && e.status === 404);
		assert.throws(() => patchCard(id, "../x", { deleted: true }, deps), (e) => e instanceof CreateInputError && e.status === 404);
	});
});


// ─── the focus screen ────────────────────────────────────────────────────────

/** Page 1: a question card, a picture question, and an occlusion card with two masks. */
const FOCUS_ANSWER = JSON.stringify({
	topic: "Topic 1",
	cards: [
		{ type: "basic", priority: 1, front: "Where does blood back up?", back: "Into the lungs.", evidence: "Blood backs up into the lungs", source: ["L2"] },
		{ type: "image_question", priority: 2, front: "What does this figure show?", back: "The lungs.", image: { ref: "F1" }, evidence: "Blood backs up into the lungs", source: ["L2"] },
		{
			type: "image_occlusion",
			header: "Name the structure",
			figure: { ref: "F1" },
			occlusions: [
				{ label: "Aorta", bbox: [0.2, 0.5, 0.26, 0.54], priority: 1 },
				{ label: "Vena cava", bbox: [0.6, 0.6, 0.66, 0.64], priority: 1 },
			],
		},
	],
});

async function focusJob(over: Partial<CardsDeps> = {}) {
	const made = setup(
		{
			ask: async (req) => {
				if (isGlossary(req)) return { text: JSON.stringify({ terms: [] }), costUsd: 0, durationMs: 1 };
				if (isCritic(req)) return { text: JSON.stringify({ cards: [] }), costUsd: 0, durationMs: 1 };
				return { text: FOCUS_ANSWER, costUsd: 0, durationMs: 1 };
			},
			...over,
		},
		2,
	);
	const id = await runJob(made.deps);
	const cardsOf = (page: number) => made.create.readCardPage(id, page)!.cards;
	return { ...made, id, cardsOf };
}

const fileOnDisk = (deps: CardsDeps, id: string, name: string | null | undefined) => Boolean(name) && fs.existsSync(path.join(deps.create.mediaDir(id), name!));

describe("changing a draft card", () => {
	it("changes the texts, importance and tags, marks the card edited and keeps it on disk", async () => {
		const { deps, id, cardsOf } = await focusJob();
		const [basic] = cardsOf(1) as FrontBackCard[];
		const out = patchCard(id, basic!.id, { front: "Where does blood back up in left heart failure?", tier: 1, tags: "heart, lungs" }, deps) as FrontBackCard;
		assert.equal(out.front, "Where does blood back up in left heart failure?");
		assert.equal(out.edited, true);
		const saved = cardsOf(1).find((c) => c.id === basic!.id) as FrontBackCard;
		assert.deepEqual([saved.front, saved.tier, saved.tags], [out.front, 1, ["heart", "lungs"]]);
	});

	it("refuses an invalid change whole, a study card, an unknown card and a page that is being worked on", async () => {
		const { deps, id, cardsOf, create } = await focusJob();
		const [basic, picture] = cardsOf(1) as FrontBackCard[];
		const before = JSON.stringify(cardsOf(1));
		assert.throws(() => patchCard(id, basic!.id, { front: "New?", back: "  " }, deps), (e) => e instanceof CreateInputError && e.status === 400);
		assert.equal(JSON.stringify(cardsOf(1)), before, "nothing was changed");

		adoptCards(id, { courseId: "cardio", cardIds: [picture!.id] }, deps);
		assert.throws(() => patchCard(id, picture!.id, { tier: 3 }, deps), (e) => e instanceof CreateInputError && e.status === 409);
		assert.throws(() => patchCard(id, "p001-c99", { tier: 3 }, deps), (e) => e instanceof CreateInputError && e.status === 404);

		create.update(id, (j) => {
			j.pages["1"]!.status = "running";
		});
		assert.throws(() => patchCard(id, basic!.id, { tier: 3 }, deps), (e) => e instanceof CreateInputError && e.status === 409);
	});
});

describe("choosing the cards to adopt", () => {
	it("adopts only the selected cards unless some are named", async () => {
		const { deps, id, cardsOf, study } = await focusJob();
		const ids = cardsOf(1).map((c) => c.id);
		assert.equal(ids.length, 4);
		assert.equal(setInclude(id, { cardIds: [ids[0]!, ids[1]!, "p002-c01"], include: false }, deps), 3);
		assert.equal(setInclude(id, { cardIds: [ids[0]!], include: false }, deps), 0, "already unselected");
		assert.equal(cardsOf(1).filter((c) => !c.include).length, 2);

		const result = adoptCards(id, { courseId: "cardio" }, deps);
		const adopted = study.readCards().map((c) => c.id.replace(`crt_${id}_`, ""));
		assert.equal(result.adopted, adopted.length);
		assert.ok(adopted.includes(ids[2]!) && adopted.includes(ids[3]!), "the selected cards became study cards");
		assert.ok(![ids[0]!, ids[1]!, "p002-c01"].some((x) => adopted.includes(x)), "an unselected draft stays a draft");
		assert.equal(cardsOf(1).find((c) => c.id === ids[0])!.adopted, undefined);

		// naming a card adopts it whatever its selection
		assert.equal(adoptCards(id, { courseId: "cardio", cardIds: [ids[0]!] }, deps).adopted, 1);
	});
});

describe("cards by hand", () => {
	it("adds a question card that survives, numbered after the highest card", async () => {
		const { deps, id, cardsOf } = await focusJob();
		const before = cardsOf(1).length;
		const cards = await addManualCard(id, 1, { type: "basic", front: "What is preload?", back: "The stretch of the ventricle before it contracts.", tier: 1 }, deps);
		assert.equal(cards.length, before + 1);
		const made = cardsOf(1).at(-1) as FrontBackCard;
		assert.equal(made.id, `p001-c0${before + 1}`);
		assert.equal(made.manual, true);
		assert.equal(made.tier, 1);
		assert.equal(deps.create.get(id)!.pages["1"]!.count, before + 1, "the page counter follows");
	});

	it("adds an occlusion over a drawn area with its two pictures", async () => {
		const { deps, id, cardsOf } = await focusJob();
		const cards = await addManualCard(id, 1, { type: "image_occlusion", label: "Mitral valve", bbox: [0.3, 0.7, 0.4, 0.75] }, deps);
		const made = cards.at(-1) as OcclusionCard;
		assert.equal(made.manual, true);
		assert.equal(made.maskExact, true);
		assert.ok(fileOnDisk(deps, id, made.questionFile) && fileOnDisk(deps, id, made.answerFile));
		assert.ok((cardsOf(1).at(-1) as OcclusionCard).questionFile, "saved");
	});

	it("refuses an occlusion without an area, an unprocessed page, an unknown page and a page that is being worked on", async () => {
		const { deps, id } = await focusJob();
		await assert.rejects(addManualCard(id, 1, { type: "image_occlusion", label: "x" }, deps), (e) => e instanceof CreateInputError && e.status === 400);
		await assert.rejects(addManualCard(id, 1, { type: "basic", front: "Q?", back: "" }, deps), (e) => e instanceof CreateInputError && e.status === 400);
		await assert.rejects(addManualCard(id, 9, { type: "basic", front: "Q?", back: "A" }, deps), (e) => e instanceof CreateInputError && e.status === 404);
		const fresh = await createCardsJob({ lectureId: "lec1", autostart: false }, deps);
		await assert.rejects(addManualCard(fresh.id, 1, { type: "basic", front: "Q?", back: "A" }, deps), (e) => e instanceof CreateInputError && e.status === 409);

		// two changes at once: the second is refused, not lost
		const slow = addManualCard(id, 1, { type: "image_occlusion", label: "Mitral valve", bbox: [0.3, 0.7, 0.4, 0.75] }, deps);
		await assert.rejects(addManualCard(id, 1, { type: "basic", front: "Q?", back: "A" }, deps), (e) => e instanceof CreateInputError && e.status === 409);
		await slow;
	});
});

describe("moving a mask and a picture", () => {
	it("moves the mask exactly, draws the pictures again and removes the old ones", async () => {
		const { deps, id, cardsOf } = await focusJob();
		const mask = cardsOf(1).find((c) => c.type === "image_occlusion") as OcclusionCard;
		const oldQuestion = mask.questionFile;
		assert.ok(fileOnDisk(deps, id, oldQuestion));
		const cards = await editMask(id, mask.id, { bbox: [0.4, 0.55, 0.5, 0.6] }, deps);
		const moved = cards.find((c) => c.id === mask.id) as OcclusionCard;
		assert.deepEqual(moved.boxes, [[0.4, 0.55, 0.5, 0.6]]);
		assert.equal(moved.maskExact, true);
		assert.equal(moved.edited, true);
		assert.ok(fileOnDisk(deps, id, moved.questionFile));
		assert.notEqual(moved.questionFile, oldQuestion);
		assert.equal(fileOnDisk(deps, id, oldQuestion), false, "the old picture is gone");
		assert.deepEqual((cardsOf(1).find((c) => c.id === mask.id) as OcclusionCard).boxes, moved.boxes);
	});

	it("changes the shown part of the figure for the whole group", async () => {
		const { deps, id, cardsOf } = await focusJob();
		const [a, b] = cardsOf(1).filter((c): c is OcclusionCard => c.type === "image_occlusion");
		await editMask(id, a!.id, { figure: [0.1, 0.45, 0.8, 0.7] }, deps);
		const [na, nb] = cardsOf(1).filter((c): c is OcclusionCard => c.type === "image_occlusion");
		assert.deepEqual(na!.figureBbox, nb!.figureBbox);
		assert.equal(na!.figureExact, true);
		assert.ok(b);
	});

	it("refuses a card without a mask, an invalid box and a study card", async () => {
		const { deps, id, cardsOf } = await focusJob();
		const basic = cardsOf(1)[0]!;
		const mask = cardsOf(1).find((c) => c.type === "image_occlusion")!;
		await assert.rejects(editMask(id, basic.id, { bbox: [0.1, 0.1, 0.2, 0.2] }, deps), (e) => e instanceof CreateInputError && e.status === 400);
		await assert.rejects(editMask(id, mask.id, { bbox: [0.5, 0.5, 0.4, 0.4] }, deps), (e) => e instanceof CreateInputError && e.status === 400);
		await assert.rejects(editMask(id, mask.id, {}, deps), (e) => e instanceof CreateInputError && e.status === 400);
		adoptCards(id, { courseId: "cardio", cardIds: [mask.id] }, deps);
		await assert.rejects(editMask(id, mask.id, { bbox: [0.4, 0.55, 0.5, 0.6] }, deps), (e) => e instanceof CreateInputError && e.status === 409);
	});

	it("changes the shown part of a context picture", async () => {
		const { deps, id, cardsOf } = await focusJob();
		const picture = cardsOf(1).find((c) => c.type === "basic" && c.image) as FrontBackCard;
		const card = (await editImage(id, picture.id, [0.2, 0.5, 0.6, 0.8], deps)) as FrontBackCard;
		assert.deepEqual(card.image!.bbox, [0.2, 0.5, 0.6, 0.8]);
		assert.ok(fileOnDisk(deps, id, card.image!.file));
		assert.equal(card.edited, true);
		await assert.rejects(editImage(id, picture.id, [0.6, 0.5, 0.2, 0.8], deps), (e) => e instanceof CreateInputError && e.status === 400);
		const plain = cardsOf(1).find((c) => c.type === "basic" && !c.image)!;
		await assert.rejects(editImage(id, plain.id, [0.2, 0.5, 0.6, 0.8], deps), (e) => e instanceof CreateInputError && e.status === 400);
	});
});

describe("the page and the focus topics", () => {
	it("serves the rendered page of a processed page only", async () => {
		const { deps, id } = await focusJob();
		assert.equal(pageImageFile(id, 1, deps), path.join(deps.create.workDir(id), "pages", "p001.png"));
		assert.throws(() => pageImageFile(id, 9, deps), (e) => e instanceof CreateInputError && e.status === 404);
		const fresh = await createCardsJob({ lectureId: "lec1", autostart: false }, deps);
		assert.throws(() => pageImageFile(fresh.id, 1, deps), (e) => e instanceof CreateInputError && e.status === 404);
	});

	it("changes the focus topics of the job", async () => {
		const { deps, id } = await focusJob();
		assert.deepEqual(setFocus(id, { focusTopics: "heart failure; troponin, heart failure", focusStrict: true }, deps), { focusTopics: ["heart failure", "troponin"], focusStrict: true });
		assert.deepEqual(setFocus(id, { focusStrict: false }, deps), { focusTopics: ["heart failure", "troponin"], focusStrict: false });
		assert.deepEqual(getCardsJob(id, deps).settings.focusTopics, ["heart failure", "troponin"]);
		assert.throws(() => setFocus("nope", {}, deps), (e) => e instanceof CreateInputError && e.status === 404);
	});
});

describe("duplicates", () => {
	const similar = [
		{ type: "basic", front: "Which artery supplies the right ventricle wall?", back: "The right coronary artery" },
		{ type: "basic", front: "Which artery supplies the right ventricle wall?", back: "Right coronary artery (RCA)" },
		{ type: "basic", front: "Which vessel feeds the wall of the right ventricle?", back: "Right coronary artery" },
	];

	async function withSimilarCards(over: Partial<CardsDeps> = {}) {
		const made = await focusJob(over);
		for (const card of similar) await addManualCard(made.id, 2, card, made.deps);
		return made;
	}

	it("lists the groups of similar cards and throws the others away, restorable", async () => {
		const { deps, id, cardsOf } = await withSimilarCards();
		const review = reviewDuplicates(id, 0.6, deps);
		const group = review.groups.find((g) => g.cards.some((c) => c.page === 2 && (c as FrontBackCard).back === "The right coronary artery"))!;
		assert.ok(group, "the two identically worded questions form a group");
		const others = group.cards.filter((c) => c.id !== group.keep).map((c) => c.id);
		assert.equal(removeDuplicates(id, [{ keep: group.keep, remove: [...others, group.keep] }], deps), others.length, "the card kept is never removed");
		const gone = cardsOf(2).find((c) => c.id === others[0])!;
		assert.equal(gone.deleted, true);
		assert.equal(gone.note, `Duplicate of ${group.keep}`);
		assert.equal(removeDuplicates(id, [{ keep: group.keep, remove: others }], deps), 0, "nothing twice");
		assert.equal(reviewDuplicates(id, 0.6, deps).autoRemoved >= others.length, true);
		assert.equal(patchCard(id, others[0]!, { deleted: false }, deps).deleted, false);
	});

	it("never removes a card that another group keeps, so overlapping groups cannot lose both copies", async () => {
		const { deps, id, cardsOf } = await withSimilarCards();
		const [a, b] = cardsOf(2).filter((c) => c.manual);
		assert.equal(removeDuplicates(id, [{ keep: a!.id, remove: [b!.id] }, { keep: b!.id, remove: [a!.id] }], deps), 0);
		assert.deepEqual(cardsOf(2).filter((c) => c.id === a!.id || c.id === b!.id).map((c) => c.deleted), [false, false]);
	});

	it("leaves study cards alone", async () => {
		const { deps, id, cardsOf } = await withSimilarCards();
		const mine = cardsOf(2).find((c) => c.manual)!;
		adoptCards(id, { courseId: "cardio", cardIds: [mine.id] }, deps);
		assert.equal(removeDuplicates(id, [{ keep: "p001-c01", remove: [mine.id] }], deps), 0);
		assert.equal(cardsOf(2).find((c) => c.id === mine.id)!.deleted, false);
	});

	const dedupeAnswer = (req: AskClaudeRequest) => {
		const pairs = [...req.prompt.matchAll(/^- (\S+) <-> (\S+)$/gm)].map((m) => [m[1]!, m[2]!]);
		return { text: JSON.stringify({ groups: pairs.slice(0, 1) }), costUsd: 0, durationMs: 1 };
	};

	it("asks Claude about the weak candidates once, keeps the progress and offers its groups", async () => {
		const asks: AskClaudeRequest[] = [];
		const { deps, id } = await withSimilarCards({
			ask: async (req) => {
				if (req.system === DEDUPE_SYSTEM) {
					asks.push(req);
					return dedupeAnswer(req);
				}
				if (isGlossary(req)) return { text: JSON.stringify({ terms: [] }), costUsd: 0, durationMs: 1 };
				if (isCritic(req)) return { text: JSON.stringify({ cards: [] }), costUsd: 0, durationMs: 1 };
				return { text: FOCUS_ANSWER, costUsd: 0, durationMs: 1 };
			},
		});
		const step = await semanticDedupeStep(id, { threshold: 0.95 }, deps);
		assert.equal(step.error, null);
		assert.equal(asks.length, 1);
		assert.equal(asks[0]!.model, "haiku");
		assert.ok(step.checkedNow >= 2);
		assert.equal(step.done, true);
		assert.equal(step.groups.length, 1);
		assert.equal(step.groups[0]!.semantic, true);
		assert.ok(step.groups[0]!.cards.length >= 2);
		assert.deepEqual(semanticGroups(id, deps).map((g) => g.cards.map((c) => c.id)), step.groups.map((g) => g.cards.map((c) => c.id)));
		assert.ok(deps.create.readDedupeCache(id).checked.length >= 2, "kept for the next time");

		// every card is asked about once, never again
		const again = await semanticDedupeStep(id, { threshold: 0.95 }, deps);
		assert.deepEqual([again.checkedNow, again.done, asks.length], [0, true, 1]);

		// a card thrown away drops out of Claude's group
		const members = step.groups[0]!.cards.map((c) => c.id);
		patchCard(id, members[1]!, { deleted: true }, deps);
		assert.equal(semanticGroups(id, deps).length, 0);
	});

	it("reports a failed call and keeps the progress", async () => {
		const { deps, id } = await withSimilarCards({
			ask: async (req) => {
				if (req.system === DEDUPE_SYSTEM) throw new ClaudeAskError("network down", "other");
				if (isGlossary(req)) return { text: JSON.stringify({ terms: [] }), costUsd: 0, durationMs: 1 };
				if (isCritic(req)) return { text: JSON.stringify({ cards: [] }), costUsd: 0, durationMs: 1 };
				return { text: FOCUS_ANSWER, costUsd: 0, durationMs: 1 };
			},
		});
		const step = await semanticDedupeStep(id, { threshold: 0.95 }, deps);
		assert.match(step.error ?? "", /network down/);
		assert.equal(step.done, false);
		assert.ok(step.remaining >= 1);
		assert.deepEqual(deps.create.readDedupeCache(id), { checked: [], groups: [] });
	});
});

describe("a cards job for a subject", () => {
	const topicsOf = (deps: CardsDeps, id: string) => {
		const { focusTopics, focusStrict } = getCardsJob(id, deps).settings;
		return [focusTopics, focusStrict];
	};

	it("takes the topics of the subject as its focus, unless the form names a focus of its own", async () => {
		const { deps, study } = setup();
		study.upsertCourse({ id: "cardio", name: "Cardiology", bufferDays: 5, createdAt: NOW.toISOString(), topics: ["Heart failure", "Valves"], strictTopics: true });
		const job = await createCardsJob({ lectureId: "lec1", courseId: "cardio", autostart: false }, deps);
		assert.equal(job.courseId, "cardio");
		assert.deepEqual(topicsOf(deps, job.id), [["Heart failure", "Valves"], true]);

		const own = await createCardsJob({ lectureId: "lec1", courseId: "cardio", settings: { focusTopics: "Rhythm" }, autostart: false }, deps);
		assert.deepEqual(topicsOf(deps, own.id), [["Rhythm"], false]);
		const none = await createCardsJob({ lectureId: "lec1", courseId: "cardio", settings: { focusTopics: "" }, autostart: false }, deps);
		assert.deepEqual(topicsOf(deps, none.id), [[], false], "a form that sent an empty focus meant it");

		const loose = await createCardsJob({ lectureId: "lec1", autostart: false }, deps);
		assert.equal(loose.courseId, undefined);
		await assert.rejects(createCardsJob({ lectureId: "lec1", courseId: "nope", autostart: false }, deps), (e) => e instanceof CreateInputError && e.status === 404);
	});

	/** Study cards of the course with `answers` reviews, `again` of them "Again". */
	const remembered = (study: ReturnType<typeof setup>["study"], answers: number, again: number) => {
		study.upsertCard({ id: "old1", courseId: "cardio", kind: "basic", fields: { Front: "q", Back: "a" }, tags: [], core: false, origin: { kind: "manual" }, createdAt: NOW.toISOString() });
		const at = (i: number) => new Date(NOW.getTime() - 86_400_000 * 3 + i * 1000).toISOString();
		study.appendReviews(Array.from({ length: answers }, (_, i) => ({ cardId: "old1", at: at(i), grade: i < again ? (1 as const) : (3 as const) })));
	};
	const pageSystem = (asked: AskClaudeRequest[]) => asked.find((r) => !isGlossary(r) && !isCritic(r))!.system;

	it("tells the page prompts when the subject was remembered badly lately — once per job", async () => {
		const { deps, study, asked } = setup({}, 1);
		remembered(study, 60, 30);
		const summary = await createCardsJob({ lectureId: "lec1", courseId: "cardio", autostart: false }, deps);
		await startCardsJob(summary.id, {}, deps).settled;
		assert.match(pageSystem(asked), /# Rückmeldung aus früherem Lernen\nIm Fach „Cardiology“ lag die Retention .* nur bei 50%/);
		const job = deps.create.get(summary.id);
		assert.match(job?.kind === "cards" ? (job.retentionHint ?? "") : "", /Cardiology/);

		// fixed for the job: better reviews later do not change a rerun
		remembered(study, 400, 0);
		asked.length = 0;
		await startCardsJob(summary.id, { pages: [1] }, deps).settled;
		assert.match(pageSystem(asked), /nur bei 50%/);
	});

	it("says nothing when the subject was fine, unknown, or the PDF has no subject", async () => {
		for (const [answers, again, courseId] of [[60, 6, "cardio"], [10, 9, "cardio"], [0, 0, "cardio"], [60, 30, undefined]] as const) {
			const { deps, study, asked } = setup({}, 1);
			if (answers > 0) remembered(study, answers, again);
			const summary = await createCardsJob({ lectureId: "lec1", ...(courseId ? { courseId } : {}), autostart: false }, deps);
			await startCardsJob(summary.id, {}, deps).settled;
			assert.doesNotMatch(pageSystem(asked), /Rückmeldung aus früherem Lernen/, `${answers} answers, ${again} again, ${courseId}`);
			const job = deps.create.get(summary.id);
			assert.equal(job?.kind === "cards" ? job.retentionHint : "x", "");
		}
	});

	it("files an adopted draft under the topic it was given, else under the PDF's name", async () => {
		const { deps, study, create } = setup({}, 1);
		study.upsertCourse({ id: "cardio", name: "Cardiology", bufferDays: 5, createdAt: NOW.toISOString(), topics: ["Valves"] });
		const id = await runJob(deps);
		const page = create.readCardPage(id, 1)!;
		page.cards[0]!.tags = ["Valves"];
		page.cards[1]!.tags = ["Something else"];
		create.writeCardPage(id, page);
		adoptCards(id, { courseId: "cardio" }, deps);
		const made = study.readCards().filter((c) => c.courseId === "cardio");
		assert.deepEqual(made.map((c) => c.topic), ["Valves", "Cardiology"]);
		assert.ok(made[0]!.tags.includes("Valves"));
	});
});
