/**
 * Where the Obsidian vault is, and the last linking result (Learnbox 2.0, 2026-11): data/vault.json
 * (config.VAULT_FILE), a small read-modify-write record. MedAnki kept both in its app settings: the learner's
 * choice wins, then the environment (here LH_VAULT_DIR), then ~/Documents/Medizinstudium.
 * `createVaultSettings(file, …)` takes the file so tests run in a temp dir.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VAULT_DIR_ENV, VAULT_FILE } from "../../config.ts";
import type { LinkResult } from "../core/contracts/create-notes.ts";

export interface VaultLocation {
	path: string;
	/** Chosen by the learner (not the default, not set from outside). */
	custom: boolean;
	defaultPath: string;
}

export interface VaultSettings {
	location(): VaultLocation;
	/** Remember the vault's folder; null = back to the default. The path must be absolute (a leading ~ is the home folder). */
	setPath(raw: string | null): void;
	lastLink(): LinkResult | null;
	saveLink(result: LinkResult): void;
}

interface VaultRecord {
	path?: string;
	linkResult?: LinkResult;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isLinkResult(v: unknown): v is LinkResult {
	if (!isRecord(v)) return false;
	const nums = ["notes", "own", "linked", "links", "written", "removed", "llmFailed"] as const;
	return nums.every((k) => typeof v[k] === "number") && typeof v.llm === "boolean" && typeof v.colors === "boolean" && typeof v.at === "string";
}

export class VaultPathError extends Error {}

export function createVaultSettings(file: string, opts: { env?: string; home?: string } = {}): VaultSettings {
	const home = opts.home ?? os.homedir();
	const defaultPath = path.join(home, "Documents", "Medizinstudium");
	const expand = (p: string): string => (p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p);

	const read = (): VaultRecord => {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
			if (!isRecord(parsed)) return {};
			return {
				...(typeof parsed.path === "string" && parsed.path.trim() ? { path: parsed.path } : {}),
				...(isLinkResult(parsed.linkResult) ? { linkResult: parsed.linkResult } : {}),
			};
		} catch {
			return {};
		}
	};
	const write = (record: VaultRecord): void => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(record, null, 1), "utf8");
		fs.renameSync(tmp, file);
	};

	return {
		location() {
			const saved = read().path;
			const raw = saved ?? (opts.env?.trim() ? opts.env.trim() : undefined);
			return { path: path.resolve(expand(raw ?? defaultPath)), custom: saved !== undefined, defaultPath };
		},
		setPath(raw) {
			const record = read();
			const text = raw?.trim() ?? "";
			if (text === "") delete record.path;
			else {
				const p = expand(text);
				if (!path.isAbsolute(p)) throw new VaultPathError("Please give an absolute path (for example /Users/…/Medizinstudium).");
				if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) throw new VaultPathError("This path is a file, not a folder.");
				record.path = path.resolve(p);
			}
			write(record);
		},
		lastLink: () => read().linkResult ?? null,
		saveLink(result) {
			write({ ...read(), linkResult: result });
		},
	};
}

/** The live setting (data/vault.json; LH_VAULT_DIR when the learner chose nothing). */
export const vaultSettings: VaultSettings = createVaultSettings(VAULT_FILE, { env: VAULT_DIR_ENV });
