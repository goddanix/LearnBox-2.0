/**
 * The vault and the linking run behind the button (src/server/create-vault.ts) with a scripted model and a throw-away
 * vault — never the learner's.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { AskClaude } from "../src/agent/claude-ask.ts";
import { CreateInputError } from "../src/core/contracts.ts";
import { linkStatus, resetLinkState, setVaultPath, startLink, unlinkNotes, vaultInfo, type VaultDeps } from "../src/server/create-vault.ts";
import { createVaultSettings } from "../src/store/vault-settings.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-vault-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => resetLinkState());

function setup(ask: AskClaude = async () => ({ text: '{"links": []}', costUsd: 0, durationMs: 1 })) {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const vault = createVaultSettings(path.join(dir, "vault.json"), { home: dir });
	const vaultDir = path.join(dir, "Vault");
	vault.setPath(vaultDir);
	const deps: VaultDeps = { ask, create: { workDir: () => dir } as unknown as VaultDeps["create"], vault, now: () => new Date(2026, 10, 5, 9, 8, 7), retryDelayMs: 0 };
	return { deps, vault, vaultDir, dir };
}

const note = (id: string, fach: string, title: string, body: string) => `---\nfach: "${fach}"\ntags:\n  - medizinstudium\nmedanki_id: ${id}\n---\n\n# ${title}\n\n${body}\n\n## Eigene Notizen\n\n`;
function fill(vaultDir: string): void {
	fs.mkdirSync(path.join(vaultDir, "Anatomy/Themen"), { recursive: true });
	fs.mkdirSync(path.join(vaultDir, "Physiology/Themen"), { recursive: true });
	fs.writeFileSync(path.join(vaultDir, "Anatomy/Themen/Heart.md"), note("a-1", "Anatomy", "Heart", "> [!abstract] Kernaussagen\n> - **Atrium** and **ventricle**\n\n## Cardiac chambers\n- **Valves** regulate flow"));
	fs.writeFileSync(path.join(vaultDir, "Physiology/Themen/Valves.md"), note("p-1", "Physiology", "Valves", "> [!abstract] Kernaussagen\n> - **Valves** regulate **cardiac** flow\n\n## Cardiac valves\n- **Atrium** pressure and **ventricle** filling"));
}

async function over(deps: VaultDeps): Promise<ReturnType<typeof linkStatus>> {
	for (let i = 0; i < 400; i++) {
		const st = linkStatus(deps);
		if (st.state !== "running") return st;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("the run did not finish");
}

describe("where the vault is", () => {
	it("tells whether it exists and which course folders it has", () => {
		const { deps, vaultDir } = setup();
		assert.deepEqual(vaultInfo(deps), { path: vaultDir, exists: false, defaultPath: path.join(path.dirname(vaultDir), "Documents", "Medizinstudium"), custom: true, folders: [] });
		fill(vaultDir);
		const info = vaultInfo(deps);
		assert.equal(info.exists, true);
		assert.deepEqual(info.folders, ["Anatomy", "Physiology"]);
	});

	it("changes the path, or goes back to the default, and refuses what cannot be a vault", () => {
		const { deps, dir } = setup();
		assert.equal(setVaultPath(path.join(dir, "Elsewhere"), deps).path, path.join(dir, "Elsewhere"));
		assert.equal(setVaultPath("", deps).custom, false);
		assert.throws(() => setVaultPath("relative/path", deps), (e) => e instanceof CreateInputError && e.status === 400 && /absolute/.test(e.message));
		assert.throws(() => setVaultPath(7, deps), /must be text/);
	});
});

describe("linking in the background", () => {
	it("refuses a vault that does not exist yet", () => {
		const { deps } = setup();
		assert.throws(() => startLink({}, deps), (e) => e instanceof CreateInputError && /save notes into the vault first/.test(e.message));
	});

	it("runs, reports its progress, and remembers the result", async () => {
		const { deps, vaultDir, vault } = setup();
		fill(vaultDir);
		assert.equal(linkStatus(deps).state, "idle");
		assert.equal(startLink({ llm: false }, deps), true);
		assert.equal(startLink({ llm: false }, deps), false, "a run is going already");
		const st = await over(deps);
		assert.equal(st.state, "done");
		assert.equal(st.error, "");
		assert.deepEqual([st.last?.notes, st.last?.own, st.last?.links, st.last?.llm, st.last?.at], [2, 2, 1, false, "2026-11-05T09:08:07"]);
		assert.deepEqual(vault.lastLink(), st.last, "kept for the next visit");
		assert.ok(fs.readFileSync(path.join(vaultDir, "Anatomy/Themen/Heart.md"), "utf8").includes("## Verwandte Themen"));
	});

	it("reports a vault with too few notes as an error of the run, not a crash", async () => {
		const { deps, vaultDir } = setup();
		fs.mkdirSync(vaultDir, { recursive: true });
		startLink({}, deps);
		const st = await over(deps);
		assert.equal(st.state, "error");
		assert.match(st.error, /fewer than two notes/);
	});

	it("takes the links out again", async () => {
		const { deps, vaultDir } = setup();
		fill(vaultDir);
		startLink({ llm: false }, deps);
		await over(deps);
		assert.equal(unlinkNotes(deps), 2);
		assert.equal(fs.readFileSync(path.join(vaultDir, "Anatomy/Themen/Heart.md"), "utf8").includes("Verwandte Themen"), false);
		assert.equal(unlinkNotes(deps), 0);
	});

	it("refuses to unlink a vault that is not there", () => {
		const { deps } = setup();
		assert.throws(() => unlinkNotes(deps), /does not exist/);
	});
});
