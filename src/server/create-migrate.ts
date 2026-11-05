/**
 * Bringing everything over from MedAnki (Learnbox 2.0, 2026-11, Slice 8): its subjects, PDF jobs with their cards, pictures and
 * page layouts, the topic notes and audio summary of a subject, and the Obsidian vault it wrote to. MedAnki's folder is only ever
 * READ; turning MedAnki off is a separate decision of the learner's. The mapping rules are core/legacy-cards.ts and
 * core/legacy-course.ts; the multiple-choice jobs stay create-legacy.ts's.
 *
 * - A subject becomes a course of the same id (its vault key too, so the notes already in the vault are updated, not written twice).
 *   The study cards the Anki import made stay where they are.
 * - A job becomes a cards job `crt_legacy_<id>`; its PDF goes into the shared library (the same PDF is stored once). A card that
 *   already exists as a study card — MedAnki's Anki push tagged it `MedAnkiID_<job>_<card>` — is marked adopted instead of
 *   becoming a second card. A job is written piece by piece and its record last, so a cut-off import leaves nothing half-there
 *   and a second import does the whole job again.
 * - Notes and audio are brought only for a subject that has none yet; the vault becomes MedAnki's folder unless the learner chose one.
 * - Not carried over: the ElevenLabs key (the learner enters it in Settings → Keys), MedAnki's caches.
 *
 * Idempotent. `scanMedAnki` is the dry run and writes nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_VOICE_ID } from "../agent/audio/elevenlabs.ts";
import {
	type Adoption,
	CREATE_SCHEMA,
	CreateInputError,
	type CardPageResult,
	type CardSettings,
	type CardsJob,
	type CreatePage,
	type MigrateCourse,
	type MigrateJob,
	type MigrateJobChoice,
	type MigrateResult,
	type MigrateScan,
	type StudyCard,
} from "../core/contracts.ts";
import { clampPageRange } from "../core/create.ts";
import { legacyCardSettings, legacyCardTag, legacyGlossary, legacyHeadings, legacyJobState, legacyLayout, legacyMediaOf, legacyPageEntry, legacyPageResult } from "../core/legacy-cards.ts";
import {
	type LegacyCourse,
	legacyAudio,
	legacyCourseRecord,
	legacyCourses,
	legacyFigureFiles,
	legacyJobId,
	legacyLinkResult,
	legacyNotes,
	legacyVaultPath,
	legacyVoice,
} from "../core/legacy-course.ts";
import { type AudioStore, audioStore } from "../store/audio.ts";
import { type NotesStore, notesStore } from "../store/notes.ts";
import { type VaultSettings, vaultSettings } from "../store/vault-settings.ts";
import { defaultCreateDeps, type CreateDeps } from "./create-shared.ts";
import { importMedAnkiMcq, resolveDataDir, scanMedAnkiMcq } from "./create-legacy.ts";

export interface MigrateDeps extends CreateDeps {
	notes: NotesStore;
	audio: AudioStore;
	vault: VaultSettings;
}

export const defaultMigrateDeps = (): MigrateDeps => ({ ...defaultCreateDeps(), notes: notesStore, audio: audioStore, vault: vaultSettings });

const ID = /^[\w-]+$/;
/** A picture's file name: no folders, nothing hidden. */
const MEDIA_NAME = /^[\w][\w.-]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

const pageFile = (page: number) => `p${String(page).padStart(3, "0")}`;

// ─── reading MedAnki's folder ────────────────────────────────────────────────

interface LegacyJob {
	dir: string;
	id: string;
	name: string;
	meta: Record<string, unknown>;
	settings: CardSettings;
	nPages: number;
	/** The pages MedAnki knew, by number. */
	pageNumbers: number[];
	results: Map<number, CardPageResult>;
}

/** The PDF jobs of a MedAnki data folder that can be read (a folder without meta.json or source.pdf is skipped). */
function readLegacyJobs(dataDir: string): LegacyJob[] {
	const base = path.join(dataDir, "jobs");
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
		const pageNumbers = Object.keys(meta.pages)
			.map(Number)
			.filter((n) => Number.isInteger(n) && n > 0)
			.sort((a, b) => a - b);
		const results = new Map<number, CardPageResult>();
		for (const page of pageNumbers) {
			const result = legacyPageResult(readJson(path.join(dir, "cards", `${pageFile(page)}.json`)), page);
			if (result) results.set(page, result);
		}
		jobs.push({
			dir,
			id,
			name: text(meta.name).trim() || id,
			meta,
			settings: legacyCardSettings(meta.settings),
			nPages: Number(meta.n_pages) || pageNumbers.length,
			pageNumbers,
			results,
		});
	}
	return jobs;
}

/** The study card that carries MedAnki's hidden tag of a pushed card (the first one when a note made several). */
function tagIndex(cards: readonly StudyCard[]): Map<string, StudyCard> {
	const index = new Map<string, StudyCard>();
	for (const c of cards) for (const t of c.tags) if (t.startsWith("MedAnkiID_") && !index.has(t)) index.set(t, c);
	return index;
}

/** The course MedAnki had a job in: its course id, else its subject's name. */
function suggestedCourse(job: LegacyJob, courses: readonly LegacyCourse[]): string | null {
	const s = isRecord(job.meta.settings) ? job.meta.settings : {};
	const byId = courses.find((c) => c.id === text(s.course_id));
	if (byId) return byId.id;
	const subject = text(job.meta.subject).trim().toLowerCase();
	return courses.find((c) => c.name.toLowerCase() === subject && subject !== "")?.id ?? null;
}

const liveCount = (job: LegacyJob): number => [...job.results.values()].reduce((n, r) => n + r.cards.filter((c) => !c.deleted).length, 0);

function legacyNoteSet(dataDir: string, course: LegacyCourse) {
	return legacyNotes(readJson(path.join(dataDir, "courses", course.id, "themen_notizen.json")), legacyJobId);
}

interface LegacyAudioFile {
	raw: unknown;
	/** The MP3 file, if it is there. */
	mp3: string | null;
}

function legacyAudioFile(dataDir: string, course: LegacyCourse): LegacyAudioFile | null {
	const dir = path.join(dataDir, "courses", course.id, "audio");
	const raw = readJson(path.join(dir, "audio.json"));
	if (!isRecord(raw) || !text(raw.script).trim()) return null;
	const name = text(raw.file);
	const mp3 = /^[\w][\w.-]*$/.test(name) && fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : null;
	return { raw, mp3 };
}

// ─── the dry run ─────────────────────────────────────────────────────────────

/** Dry run: what the import would do. Reads MedAnki's folder and Learnbox's records, writes nothing. */
export function scanMedAnki(dataDirInput?: string, deps: MigrateDeps = defaultMigrateDeps()): MigrateScan {
	const dataDir = resolveDataDir(dataDirInput);
	const settings = readJson(path.join(dataDir, "settings.json"));
	const courses = legacyCourses(settings);
	const have = new Set(deps.study.readCourses().map((c) => c.id));
	const tags = tagIndex(deps.study.readCards());

	const jobs = readLegacyJobs(dataDir).map((job): MigrateJob => {
		let linkable = 0;
		for (const r of job.results.values()) for (const c of r.cards) if (!c.deleted && tags.has(legacyCardTag(job.id, c.id))) linkable++;
		return {
			id: job.id,
			name: job.name,
			pages: job.pageNumbers.length,
			cards: liveCount(job),
			state: legacyJobState(job.meta.state),
			courseId: suggestedCourse(job, courses),
			alreadyImported: deps.create.get(legacyJobId(job.id)) !== null,
			linkable,
		};
	});

	// notes and audio count only where the import would bring them (a subject that has some already keeps them)
	const migrateCourses = courses.map(
		(c): MigrateCourse => ({
			id: c.id,
			name: c.name,
			topics: c.topics.length,
			alreadyImported: have.has(c.id),
			notes: notesWaiting(c, deps) ? (legacyNoteSet(dataDir, c)?.items.length ?? 0) : 0,
			audio: audioWaiting(c, deps) && legacyAudioFile(dataDir, c) !== null,
		}),
	);

	const medanki = legacyVaultPath(settings);
	const location = deps.vault.location();
	return {
		dataDir,
		courses: migrateCourses,
		jobs,
		vault: { medanki, medankiExists: medanki !== null && fs.existsSync(medanki), current: location.path, custom: location.custom, willSet: medanki !== null && !location.custom },
		mcq: scanMedAnkiMcq(dataDir, deps),
	};
}

// ─── the import ──────────────────────────────────────────────────────────────

/** One import at a time: a second click while it runs would write the same folders twice. */
const live = globalThis as typeof globalThis & { __lbMigrating?: boolean };

async function importJob(job: LegacyJob, courseId: string | null, tags: ReadonlyMap<string, StudyCard>, deps: MigrateDeps, at: string, out: MigrateResult): Promise<void> {
	const id = legacyJobId(job.id);
	const lecture = await deps.addPdf(text(job.meta.filename).trim() || `${job.id}.pdf`, fs.readFileSync(path.join(job.dir, "source.pdf")));

	// the cards: marked adopted where a study card carries MedAnki's tag
	const mediaNames = new Set<string>();
	for (const r of job.results.values()) {
		for (const c of r.cards) {
			const card = tags.get(legacyCardTag(job.id, c.id));
			// a card MedAnki threw away comes along as thrown away, and is not counted (the dry run does not count it either)
			if (card) {
				const adopted: Adoption = { courseId: card.courseId, cardId: card.id, at };
				c.adopted = adopted;
				if (!c.deleted) out.linked++;
			}
			if (!c.deleted) out.drafts++;
			for (const name of legacyMediaOf(c)) mediaNames.add(name);
		}
	}

	// the pictures the cards name
	const mediaDir = deps.create.mediaDir(id);
	for (const name of mediaNames) {
		const from = path.join(job.dir, "media", name);
		if (MEDIA_NAME.test(name) && fs.existsSync(from)) {
			fs.copyFileSync(from, path.join(mediaDir, name));
			out.media++;
		} else out.missingMedia++;
	}

	// the page layouts the cards were made from (the line ids the cards point at) and the pictures of the pages (the focus screen's
	// page view; MedAnki rendered them at the same size, and its .jpg files are only thumbnails)
	const pictures = path.join(deps.create.workDir(id), "pages");
	for (const page of job.pageNumbers) {
		const layout = legacyLayout(readJson(path.join(job.dir, "pages", `${pageFile(page)}.layout.json`)));
		if (layout) deps.create.writeLayout(id, page, layout);
		const picture = path.join(job.dir, "pages", `${pageFile(page)}.png`);
		if (fs.existsSync(picture)) {
			fs.mkdirSync(pictures, { recursive: true });
			fs.copyFileSync(picture, path.join(pictures, `${pageFile(page)}.png`));
			out.pictures++;
		}
	}
	for (const result of job.results.values()) deps.create.writeCardPage(id, result);

	const oldPages = isRecord(job.meta.pages) ? job.meta.pages : {};
	const pages: Record<string, CreatePage> = {};
	for (const page of job.pageNumbers) pages[String(page)] = legacyPageEntry(oldPages[String(page)], job.results.get(page) ?? null);

	const created = new Date(text(job.meta.created));
	const range = clampPageRange(job.settings.pageFrom, job.settings.pageTo, job.nPages);
	const record: CardsJob = {
		v: CREATE_SCHEMA,
		id,
		kind: "cards",
		name: job.name,
		lectureId: lecture.id,
		nPages: job.nPages,
		settings: job.settings,
		...(courseId ? { courseId } : {}),
		state: legacyJobState(job.meta.state),
		...(text(job.meta.fatal) ? { fatal: text(job.meta.fatal).slice(0, 400) } : {}),
		...(typeof job.meta.retention_hint === "string" ? { retentionHint: job.meta.retention_hint } : {}),
		...(typeof job.meta.latin_enabled === "boolean" ? { latin: job.meta.latin_enabled } : {}),
		...(Array.isArray(job.meta.glossary) ? { glossary: legacyGlossary(job.meta.glossary) } : {}),
		headings: legacyHeadings(job.meta.headings, range.from),
		createdAt: Number.isNaN(created.getTime()) ? at : created.toISOString(),
		pages,
	};
	deps.create.createJob(record); // last: from here on the job exists
}

/** Whether the subject has no topic notes / audio script of its own yet — only then does MedAnki's come along. */
const notesWaiting = (course: LegacyCourse, deps: MigrateDeps): boolean => (deps.notes.read(course.id)?.items.length ?? 0) === 0;
const audioWaiting = (course: LegacyCourse, deps: MigrateDeps): boolean => !deps.audio.read(course.id)?.script.trim();

function importNotes(dataDir: string, course: LegacyCourse, deps: MigrateDeps): boolean {
	if (!notesWaiting(course, deps)) return false;
	const doc = legacyNoteSet(dataDir, course);
	if (!doc) return false;
	const figs = deps.notes.figsDir(course.id);
	for (const name of legacyFigureFiles(doc)) {
		const from = path.join(dataDir, "courses", course.id, "figs", name);
		if (fs.existsSync(from)) fs.copyFileSync(from, path.join(figs, name));
	}
	deps.notes.update(course.id, (d) => Object.assign(d, doc));
	return true;
}

function importAudio(dataDir: string, course: LegacyCourse, deps: MigrateDeps): boolean {
	if (!audioWaiting(course, deps)) return false;
	const found = legacyAudioFile(dataDir, course);
	if (!found) return false;
	const name = found.mp3 ? path.basename(found.mp3) : null;
	const doc = legacyAudio(found.raw, legacyJobId, { file: name, at: found.mp3 ? fs.statSync(found.mp3).mtime.toISOString() : "" });
	if (!doc) return false;
	if (found.mp3 && name) deps.audio.writeFile(course.id, name, fs.readFileSync(found.mp3));
	deps.audio.update(course.id, (d) => Object.assign(d, doc));
	return true;
}

/**
 * Bring over what is not in Learnbox yet. `jobs` is the learner's choice of PDF jobs and their courses; without it every job
 * that is not here yet comes along, in the course MedAnki had it in.
 */
export async function importMedAnki(input: { path?: string; jobs?: readonly MigrateJobChoice[] } = {}, deps: MigrateDeps = defaultMigrateDeps()): Promise<MigrateResult> {
	if (live.__lbMigrating) throw new CreateInputError("An import is already running — please wait for it.", 409);
	live.__lbMigrating = true;
	try {
		const dataDir = resolveDataDir(input.path);
		const settings = readJson(path.join(dataDir, "settings.json"));
		const courses = legacyCourses(settings);
		const at = deps.now().toISOString();
		const out: MigrateResult = { courses: 0, jobs: 0, alreadyThere: 0, drafts: 0, linked: 0, media: 0, missingMedia: 0, pictures: 0, notes: 0, audio: 0, vault: "none", mcq: { imported: 0, alreadyThere: 0, questions: 0, linked: 0 } };

		// the learner's choice is checked before anything is written (the courses may be ones this import is about to make)
		const existing = deps.study.readCourses();
		const all = readLegacyJobs(dataDir);
		const known = new Set([...courses.map((c) => c.id), ...existing.map((c) => c.id)]);
		const choices = new Map<string, string | null>();
		if (input.jobs) {
			for (const choice of input.jobs) {
				if (typeof choice.id !== "string" || !all.some((j) => j.id === choice.id)) throw new CreateInputError("Unknown MedAnki job", 400);
				if (choice.courseId !== null && !known.has(choice.courseId)) throw new CreateInputError("Unknown course", 400);
				choices.set(choice.id, choice.courseId);
			}
		} else for (const job of all) choices.set(job.id, suggestedCourse(job, courses));

		// the subjects first (the jobs name them)
		for (const c of courses) {
			if (existing.some((e) => e.id === c.id)) continue;
			const clash = existing.some((e) => e.name.toLowerCase() === c.name.toLowerCase());
			deps.study.upsertCourse(legacyCourseRecord(c, clash ? `${c.name} (MedAnki)` : c.name, at));
			out.courses++;
		}

		// the PDF jobs
		const tags = tagIndex(deps.study.readCards());
		for (const job of all) {
			if (!choices.has(job.id)) continue;
			if (deps.create.get(legacyJobId(job.id))) {
				out.alreadyThere++;
				continue;
			}
			await importJob(job, choices.get(job.id) ?? null, tags, deps, at, out);
			out.jobs++;
		}

		// notes and audio of the subjects
		for (const c of courses) {
			if (importNotes(dataDir, c, deps)) out.notes++;
			if (importAudio(dataDir, c, deps)) out.audio++;
		}
		const voice = legacyVoice(settings);
		if (voice && voice !== DEFAULT_VOICE_ID && deps.audio.voice() === null) deps.audio.setVoice(voice);

		// the vault MedAnki wrote to
		const vault = legacyVaultPath(settings);
		if (vault) {
			if (deps.vault.location().custom) out.vault = "kept";
			else {
				deps.vault.setPath(vault);
				out.vault = "set";
				const link = legacyLinkResult(settings);
				if (link && !deps.vault.lastLink()) deps.vault.saveLink(link);
			}
		}

		out.mcq = await importMedAnkiMcq(dataDir, deps);
		return out;
	} finally {
		live.__lbMigrating = false;
	}
}
