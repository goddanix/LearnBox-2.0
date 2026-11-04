/**
 * Bringing MedAnki's MC-test jobs over (Learnbox 2.0, 2026-11): read
 * `<MedAnki>/data/mcq_jobs/<id>/` — meta.json, questions/pNNN.json, source.pdf
 * and an optional lecture.pdf — and turn each into a Create job whose drafts are
 * exactly the old questions. MedAnki's folder is only ever READ; turning MedAnki
 * off (or deleting its data) is a separate decision of the learner's.
 *
 * Both PDFs go into the shared library (sha256 dedupe, so a PDF already there is
 * reused). A question that already exists as a study card — the Anki import
 * carries MedAnki's MC notes — is marked adopted instead of becoming a second
 * card: first by MedAnki's own tag (`MedAnkiMcqID_<job>_<question>`), then by
 * identical question and options.
 *
 * Idempotent: a job's Learnbox id is derived from the old one, so a second
 * import skips what is there. `scanMedAnkiMcq` is the dry run.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CREATE_SCHEMA,
	CreateInputError,
	type CreateJob,
	type CreatePage,
	type LegacyMcqImport,
	type LegacyMcqJob,
	type LegacyMcqScan,
	type McqPageResult,
	type McqQuestion,
	type StudyCard,
} from "../core/contracts.ts";
import { cleanMcqSettings, mcqCardFields, validateMcqQuestion } from "../core/create.ts";
import { LECTURE_TEXT_FILE, defaultCreateDeps, type CreateDeps } from "./create.ts";

export const DEFAULT_MEDANKI_DATA = path.join(os.homedir(), "Desktop", "CLAUDE", "MedAnki", "data");

const ID = /^[\w-]+$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

/** MedAnki's `export._tag`: the job/question id as a tag. */
export function legacyMcqTag(jobId: string, questionId: string): string {
	const tag = `${jobId}_${questionId}`
		.replace(/[^\p{L}\p{N}_-]/gu, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `MedAnkiMcqID_${tag || "Dokument"}`;
}

const legacyId = (id: string) => `crt_legacy_${id}`;

function resolveDataDir(input: string | undefined): string {
	const raw = (input ?? "").trim() || DEFAULT_MEDANKI_DATA;
	const dir = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
	if (!path.isAbsolute(dir)) throw new CreateInputError("The MedAnki data folder must be an absolute path", 400);
	return dir;
}

interface LegacyJob {
	dir: string;
	id: string;
	meta: Record<string, unknown>;
	pages: McqPageResult[];
}

/** The readable MC jobs of a MedAnki data folder, with their drafts. */
function readLegacyJobs(dataDir: string): LegacyJob[] {
	const base = path.join(dataDir, "mcq_jobs");
	let ids: string[];
	try {
		ids = fs.readdirSync(base).filter((id) => ID.test(id));
	} catch {
		return [];
	}
	const jobs: LegacyJob[] = [];
	for (const id of ids.sort()) {
		const dir = path.join(base, id);
		const meta = readJson(path.join(dir, "meta.json"));
		if (!isRecord(meta) || !isRecord(meta.pages) || !fs.existsSync(path.join(dir, "source.pdf"))) continue;
		const pages: McqPageResult[] = [];
		for (const key of Object.keys(meta.pages)) {
			const page = Number(key);
			const record = readJson(path.join(dir, "questions", `p${String(page).padStart(3, "0")}.json`));
			if (!Number.isInteger(page) || !isRecord(record) || !Array.isArray(record.questions)) continue;
			const questions: McqQuestion[] = [];
			for (const raw of record.questions) {
				const draft = validateMcqQuestion(raw);
				if (!draft || !isRecord(raw) || typeof raw.id !== "string") continue;
				// MedAnki had two flags (include / deleted); a draft is gone when either says so.
				questions.push({ id: raw.id, page, ...draft, deleted: raw.deleted === true || raw.include === false });
			}
			pages.push({ page, questions });
		}
		jobs.push({ dir, id, meta, pages });
	}
	return jobs;
}

/** The study card that already holds this question, if any. */
function findCard(cards: readonly StudyCard[], job: LegacyJob, q: McqQuestion): StudyCard | undefined {
	const tag = legacyMcqTag(job.id, q.id);
	const fields = mcqCardFields(q, "");
	const same = (c: StudyCard) =>
		(["Question", "OptionA", "OptionB", "OptionC", "OptionD"] as const).every((k) => (c.fields[k] ?? "").trim() === fields[k]);
	return cards.find((c) => c.kind === "mcq" && c.tags.includes(tag)) ?? cards.find((c) => c.kind === "mcq" && same(c));
}

/** Dry run: what the import would do. Reads MedAnki's folder and the study cards, writes nothing. */
export function scanMedAnkiMcq(dataDirInput?: string, deps: CreateDeps = defaultCreateDeps()): LegacyMcqScan {
	const dataDir = resolveDataDir(dataDirInput);
	const cards = deps.study.readCards();
	const jobs = readLegacyJobs(dataDir).map((job): LegacyMcqJob => {
		const questions = job.pages.flatMap((p) => p.questions);
		return {
			id: job.id,
			name: String(job.meta.name ?? job.id),
			pages: job.pages.length,
			questions: questions.length,
			alreadyImported: deps.create.get(legacyId(job.id)) !== null,
			linkable: questions.filter((q) => findCard(cards, job, q)).length,
		};
	});
	return { dataDir, jobs };
}

/** Import every job that is not in Learnbox yet. */
export async function importMedAnkiMcq(dataDirInput?: string, deps: CreateDeps = defaultCreateDeps()): Promise<LegacyMcqImport> {
	const dataDir = resolveDataDir(dataDirInput);
	const cards = deps.study.readCards();
	const at = deps.now().toISOString();
	const out: LegacyMcqImport = { imported: 0, alreadyThere: 0, questions: 0, linked: 0 };

	for (const job of readLegacyJobs(dataDir)) {
		const id = legacyId(job.id);
		if (deps.create.get(id)) {
			out.alreadyThere++;
			continue;
		}
		const fileName = String(job.meta.filename ?? "").trim() || `${job.id}.pdf`;
		const lecture = await deps.addPdf(fileName, fs.readFileSync(path.join(job.dir, "source.pdf")));
		let sourceLectureId: string | undefined;
		if (fs.existsSync(path.join(job.dir, "lecture.pdf"))) {
			const lectureName = String(job.meta.lecture_filename ?? "").trim() || `${job.id}-lecture.pdf`;
			sourceLectureId = (await deps.addPdf(lectureName, fs.readFileSync(path.join(job.dir, "lecture.pdf")))).id;
		}

		const old = isRecord(job.meta.settings) ? job.meta.settings : {};
		const settings = cleanMcqSettings({
			model: old.model,
			language: old.language,
			questionsPerPage: old.n_questions,
			pageFrom: old.page_from,
			pageTo: old.page_to,
			concurrency: old.concurrency,
		});
		const oldPages = isRecord(job.meta.pages) ? job.meta.pages : {};
		const pages: Record<string, CreatePage> = {};
		const results: McqPageResult[] = [];
		for (const key of Object.keys(oldPages)) {
			const result = job.pages.find((p) => p.page === Number(key));
			const oldPage = isRecord(oldPages[key]) ? oldPages[key] : {};
			for (const q of result?.questions ?? []) {
				const card = findCard(cards, job, q);
				if (card) {
					q.adopted = { courseId: card.courseId, cardId: card.id, at };
					out.linked++;
				}
				out.questions++;
			}
			if (result) results.push(result);
			const live = result?.questions.filter((q) => !q.deleted) ?? [];
			const done = result !== undefined && oldPage.status === "done";
			pages[key] = {
				status: done ? "done" : oldPage.status === "error" ? "error" : "pending",
				...(oldPage.status === "error" && typeof oldPage.error === "string" ? { error: oldPage.error.slice(0, 400) } : {}),
				count: live.length,
				adopted: live.filter((q) => q.adopted).length,
			};
		}

		const created = new Date(String(job.meta.created ?? ""));
		const record: CreateJob = {
			v: CREATE_SCHEMA,
			id,
			kind: "mcq",
			name: String(job.meta.name ?? lecture.title),
			lectureId: lecture.id,
			...(sourceLectureId ? { sourceLectureId } : {}),
			nPages: Number(job.meta.n_pages) || Object.keys(pages).length,
			settings,
			state: job.meta.state === "done" ? "done" : "stopped",
			createdAt: Number.isNaN(created.getTime()) ? at : created.toISOString(),
			pages,
		};
		deps.create.createJob(record);
		for (const result of results) deps.create.writePage(id, result);
		const lectureText = path.join(job.dir, "lecture_text.txt");
		if (fs.existsSync(lectureText)) fs.copyFileSync(lectureText, path.join(deps.create.workDir(id), LECTURE_TEXT_FILE));
		out.imported++;
	}
	return out;
}
