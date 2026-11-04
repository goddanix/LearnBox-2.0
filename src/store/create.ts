/**
 * CreateStore — the fs adapter for Create jobs: one folder per job in
 * data/create/<id>/ holding
 *   job.json          the CreateJob record (progress book)
 *   results/p003.json one page's drafts (McqPageResult)
 *   work/             scratch the page prompts read — rendered page images,
 *                     the second PDF's text; the Claude CLI runs inside it
 * Implements core/ports.ts CreateStore. Idioms follow the library store: sync
 * fs, id-guarded paths, tab-indented JSON, writes through a temp file + rename
 * so a crash never leaves a half-written record. `createCreateStore(root)`
 * takes the folder so tests run in a temp dir.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { CREATE_SCHEMA, type CreateJob, type McqPageResult } from "../core/contracts/create.ts";
import type { CreateStore } from "../core/ports.ts";

const ID = /^[A-Za-z0-9_-]+$/;

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, "\t"), "utf-8");
	fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function createCreateStore(root: string): CreateStore {
	const jobDir = (id: string) => {
		if (!ID.test(id)) throw new Error(`Invalid create job id: ${id}`);
		return path.join(root, id);
	};
	const jobFile = (id: string) => path.join(jobDir(id), "job.json");
	const resultFile = (id: string, page: number) => path.join(jobDir(id), "results", `p${String(page).padStart(3, "0")}.json`);

	function get(id: string): CreateJob | null {
		const record = readJson(jobFile(id));
		// A newer stamp is refused, never half-understood (schema-stamp law).
		if (!isRecord(record) || record.v !== CREATE_SCHEMA || record.id !== id) return null;
		return record as unknown as CreateJob;
	}

	return {
		createJob(job) {
			writeJson(jobFile(job.id), job);
		},
		get,
		list() {
			let ids: string[];
			try {
				ids = fs.readdirSync(root);
			} catch {
				return [];
			}
			const jobs: CreateJob[] = [];
			for (const id of ids) {
				if (!ID.test(id)) continue;
				const job = get(id);
				if (job) jobs.push(job);
			}
			return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		},
		update(id, change) {
			const job = get(id);
			if (!job) return null;
			change(job);
			writeJson(jobFile(id), job);
			return job;
		},
		remove(id) {
			const dir = jobDir(id);
			if (!fs.existsSync(dir)) return false;
			fs.rmSync(dir, { recursive: true, force: true });
			return true;
		},
		workDir(id) {
			const dir = path.join(jobDir(id), "work");
			fs.mkdirSync(dir, { recursive: true });
			return dir;
		},
		readPage(id, page) {
			const record = readJson(resultFile(id, page));
			if (!isRecord(record) || record.page !== page || !Array.isArray(record.questions)) return null;
			return record as unknown as McqPageResult;
		},
		writePage(id, result) {
			writeJson(resultFile(id, result.page), result);
		},
	};
}

/** The live store (data/create). */
export const createStore: CreateStore = createCreateStore(PATHS.create);
