/**
 * The Obsidian vault and linking its notes (Learnbox 2.0, 2026-11), ported from MedAnki's linker.py (`run`, `unlink`,
 * the background run behind the button): where the vault is, and "link the vault" — related notes, across courses
 * too, get a section "Verwandte Themen" with links, so a net of topics appears in Obsidian's graph. The similarity and
 * the links are core/vault-link.ts, the files store/vault.ts; here: the run, Claude's check of the candidates.
 *
 * Only on a click (no automatic run). Without Claude the choice is made by similarity alone.
 */

import * as fs from "node:fs";
import { LINK_SYSTEM, linkPrompt } from "../agent/create/notes-prompts.ts";
import { CreateInputError } from "../core/contracts.ts";
import type { LinkResult, LinkStatus, VaultInfo } from "../core/contracts/create-notes.ts";
import { addPicks, BATCH, buildLinks, linkSources, linkSummary, type Picked, parseLinkPicks, pickBySimilarity, similarities } from "../core/vault-link.ts";
import { byCodePoint } from "../core/vault-text.ts";
import { applyLinks, listCourseFolders, migrateVault, rebuildIndex, scanNotes, unlinkVault, writeGraphColors } from "../store/vault.ts";
import { VaultPathError } from "../store/vault-settings.ts";
import { FAST_MODEL } from "./create-cards.ts";
import { type NotesDeps, defaultNotesDeps, localDate } from "./create-notes.ts";
import { askJson, errorText, pool, RunBlocked } from "./create-shared.ts";

/** What the vault features need of the shared collaborators. */
export type VaultDeps = Pick<NotesDeps, "ask" | "create" | "now" | "retryDelayMs" | "vault">;

// ─── where the vault is ──────────────────────────────────────────────────────

export function vaultInfo(deps: Pick<NotesDeps, "vault"> = defaultNotesDeps()): VaultInfo {
	const { path: dir, custom, defaultPath } = deps.vault.location();
	return { path: dir, exists: fs.existsSync(dir) && fs.statSync(dir).isDirectory(), defaultPath, custom, folders: listCourseFolders(dir) };
}

/** Choose the vault's folder (null or "" = back to the default). */
export function setVaultPath(raw: unknown, deps: Pick<NotesDeps, "vault"> = defaultNotesDeps()): VaultInfo {
	if (raw !== null && raw !== undefined && typeof raw !== "string") throw new CreateInputError("The path of the vault must be text", 400);
	try {
		deps.vault.setPath(raw ?? null);
	} catch (err) {
		if (err instanceof VaultPathError) throw new CreateInputError(err.message, 400);
		throw err;
	}
	return vaultInfo(deps);
}

// ─── linking ─────────────────────────────────────────────────────────────────

const isDir = (dir: string): boolean => fs.existsSync(dir) && fs.statSync(dir).isDirectory();

const pad2 = (n: number) => String(n).padStart(2, "0");
const localSeconds = (d: Date): string => `${localDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/**
 * Link the notes of a vault: read them, find the alike ones, let Claude check the candidates (without Claude, or where
 * a call fails: the choice by similarity), write the sections "Verwandte Themen". Throws CreateInputError when it cannot start.
 */
export async function linkVault(root: string, opts: { useLlm: boolean; progress?: (stage: string, done: number, total: number) => void }, deps: VaultDeps): Promise<LinkResult> {
	const progress = opts.progress ?? (() => undefined);
	if (!isDir(root)) throw new CreateInputError("The vault does not exist yet — save notes into the vault first.", 400);
	progress("Reading the notes", 0, 0);
	migrateVault(root); // the earlier visible %% markers out of every file the app wrote
	const notes = scanNotes(root);
	if (notes.length < 2) throw new CreateInputError("There are fewer than two notes in the vault — linking needs at least two.", 400);
	const byId = new Map(notes.map((n) => [n.id, n]));
	progress("Computing similarities", 0, 0);
	const cands = similarities(notes);
	const sources = notes.filter((n) => n.owned && (cands.get(n.id)?.length ?? 0) > 0);

	const picked: Picked = new Map();
	let llmFailed = 0;
	const useLlm = opts.useLlm && sources.length > 0;
	if (useLlm) {
		const batches = Array.from({ length: Math.ceil(sources.length / BATCH) }, (_, i) => sources.slice(i * BATCH, (i + 1) * BATCH));
		const results: (Map<string, Map<string, string>> | null)[] = batches.map(() => null); // null: not judged (failed, or Claude is not available)
		let blocked = false;
		let done = 0;
		progress("Checking related topics (Claude)", 0, batches.length);
		await pool(batches, 2, async (batch, i) => {
			if (blocked) return;
			try {
				const offered = linkSources(batch, cands, byId);
				const raw = await askJson(deps, { prompt: linkPrompt(offered), system: LINK_SYSTEM, cwd: deps.create.workDir("vault_linker"), model: FAST_MODEL, signal: new AbortController().signal });
				results[i] = parseLinkPicks(raw, offered);
			} catch (err) {
				if (err instanceof RunBlocked) blocked = true; // the sign-in is gone: the rest goes by similarity
			}
			progress("Checking related topics (Claude)", ++done, batches.length);
		});
		batches.forEach((batch, i) => {
			const res = results[i];
			if (res === null || res === undefined) {
				llmFailed++; // this batch: the choice by similarity
				pickBySimilarity(batch, cands, picked);
			} else addPicks(picked, res, cands);
		});
	} else pickBySimilarity(sources, cands, picked);

	progress("Writing the links", 0, 0);
	const links = buildLinks(notes, cands, picked);
	const counts = applyLinks(root, notes, links);
	rebuildIndex(root);
	const colors = writeGraphColors(root, [...new Set(notes.map((n) => n.subject).filter(Boolean))].sort(byCodePoint));
	return { ...linkSummary(notes, links, picked), ...counts, llm: useLlm, llmFailed, colors, at: localSeconds(deps.now()) };
}

/** Take every link section out of the app's own notes. Returns how many notes had one. */
export function unlinkNotes(deps: Pick<NotesDeps, "vault"> = defaultNotesDeps()): number {
	const dir = deps.vault.location().path;
	if (!isDir(dir)) throw new CreateInputError("The vault does not exist.", 400);
	return unlinkVault(dir);
}

// ─── the run behind the button ───────────────────────────────────────────────

const live = globalThis as typeof globalThis & { __lbLinkRun?: Omit<LinkStatus, "last"> };
const idle = (): Omit<LinkStatus, "last"> => ({ state: "idle", stage: "", done: 0, total: 0, error: "" });
const state = (): Omit<LinkStatus, "last"> => (live.__lbLinkRun ??= idle());

/** The state of the linking run and the result of the last one. */
export function linkStatus(deps: Pick<NotesDeps, "vault"> = defaultNotesDeps()): LinkStatus {
	return { ...state(), last: deps.vault.lastLink() };
}

/** Link the vault in the background. False if a run is going already. */
export function startLink(opts: { llm?: boolean }, deps: VaultDeps = defaultNotesDeps()): boolean {
	const root = deps.vault.location().path;
	if (!isDir(root)) throw new CreateInputError("The vault does not exist yet — save notes into the vault first.", 400);
	const st = state();
	if (st.state === "running") return false;
	Object.assign(st, { state: "running", stage: "Starting", done: 0, total: 0, error: "" });
	void (async () => {
		try {
			const result = await linkVault(root, { useLlm: opts.llm !== false, progress: (stage, done, total) => Object.assign(st, { stage, done, total }) }, deps);
			deps.vault.saveLink(result);
			Object.assign(st, { state: "done", stage: "", error: "" });
		} catch (err) {
			const message = err instanceof CreateInputError ? err.message : `Linking failed: ${errorText(err).slice(0, 300)}`;
			Object.assign(st, { state: "error", stage: "", error: message });
		}
	})();
	return true;
}

/** Test seam: forget the state of an earlier run. */
export const resetLinkState = (): void => {
	live.__lbLinkRun = idle();
};
