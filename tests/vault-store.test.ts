/**
 * The vault as files is MedAnki's: tests/fixtures/medanki-vault.json holds, step by step, what MedAnki's own Python
 * code leaves in a vault (every file's text) while notes are saved, edited by the reader, linked and unlinked.
 * These tests replay the steps with the TypeScript port and compare every file. Below that: what Learnbox added
 * (where the vault is, the note set on disk, the check by Claude as a whole, files that are not text).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { type AskClaude, ClaudeAskError } from "../src/agent/claude-ask.ts";
import { type VaultDeps, linkVault } from "../src/server/create-vault.ts";
import { createNotesStore, emptyNotesDoc } from "../src/store/notes.ts";
import { findNoteById, listCourseFolders, listMarkdown, saveTopicNotes, scanNotes, unlinkVault } from "../src/store/vault.ts";
import { createVaultSettings, VaultPathError } from "../src/store/vault-settings.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/medanki-vault.json", import.meta.url), "utf8"));

const made: string[] = [];
const tmp = (prefix: string): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lb-${prefix}-`));
	made.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Every file of the vault: its text (or the hex of binary content), like the fixture's `tree`. */
function tree(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string, rel: string): void => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(path.join(dir, e.name), r);
			else {
				const data = fs.readFileSync(path.join(dir, e.name));
				try {
					out[r] = new TextDecoder("utf-8", { fatal: true }).decode(data);
				} catch {
					out[r] = `hex:${data.toString("hex")}`;
				}
			}
		}
	};
	walk(root, "");
	return out;
}

const deps = (over: Partial<VaultDeps> = {}): VaultDeps => ({
	ask: async () => {
		throw new Error("no call expected");
	},
	create: { workDir: () => tmp("work") } as unknown as VaultDeps["create"],
	vault: undefined as unknown as VaultDeps["vault"],
	now: () => new Date(2026, 10, 5, 9, 8, 7),
	retryDelayMs: 0,
	...over,
});

const linkResult = (r: { notes: number; own: number; linked: number; links: number; written: number; removed: number; llm: boolean; llmFailed: number; colors: boolean }) => ({
	notes: r.notes,
	own: r.own,
	linked: r.linked,
	links: r.links,
	written: r.written,
	removed: r.removed,
	llm: r.llm,
	llm_failed: r.llmFailed,
	colors: r.colors,
});

/** Cuts the temporary vault path off a result, like the fixture. */
const rel = (root: string, v: unknown): unknown => {
	if (typeof v === "string" && v.startsWith(root)) return path.relative(root, v).split(path.sep).join("/");
	if (Array.isArray(v)) return v.map((x) => rel(root, x));
	if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rel(root, x)]));
	return v;
};

interface Step {
	op: string;
	args?: { subject: string; courseId: string; created: string; topics: never[]; files: { pdfs: [string, string][]; figs: [string, string][]; sources: string[] } };
	path?: string;
	text?: string;
	result?: unknown;
	tree: Record<string, string>;
}

describe("a vault over time (MedAnki's own steps)", () => {
	it("is left in the same state, file by file, after saving, editing, linking and unlinking", async () => {
		const root = tmp("vault");
		const srcs = tmp("src");
		for (const [i, step] of (fx.scenario.steps as Step[]).entries()) {
			if (step.op === "save") {
				const a = step.args!;
				const file = (name: string, content: string, tag: string) => {
					const p = path.join(srcs, `${tag}-${i}-${name}`);
					fs.writeFileSync(p, content, "utf8");
					return { src: p, name };
				};
				const res = saveTopicNotes(root, {
					subject: a.subject,
					courseId: a.courseId,
					created: a.created,
					topics: a.topics,
					pdfs: a.files.pdfs.map(([n, c]) => file(n, c, "pdf")),
					figs: a.files.figs.map(([n, c]) => file(n, c, "fig")),
					pdfSources: a.files.sources,
				});
				const got = rel(root, { moc: res.moc, moc_created: res.mocCreated, notes: res.notes, renamed: res.renamed });
				assert.deepEqual(got, step.result, `step ${i} (save): result`);
			} else if (step.op === "edit") {
				fs.mkdirSync(path.dirname(path.join(root, step.path!)), { recursive: true });
				fs.writeFileSync(path.join(root, step.path!), step.text!, "utf8");
			} else if (step.op === "link") {
				const res = await linkVault(root, { useLlm: false }, deps());
				assert.deepEqual(linkResult(res), step.result, `step ${i} (link): result`);
			} else if (step.op === "unlink") {
				assert.equal(unlinkVault(root), step.result, `step ${i} (unlink): count`);
			}
			assert.deepEqual(tree(root), step.tree, `step ${i} (${step.op}): the files`);
		}
	});

	it("cleans up the earlier visible markers and links what it finds", async () => {
		const root = tmp("legacy");
		for (const [p, text] of Object.entries(fx.legacy.before as Record<string, string>)) {
			fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
			fs.writeFileSync(path.join(root, p), text, "utf8");
		}
		const res = await linkVault(root, { useLlm: false }, deps());
		assert.deepEqual(linkResult(res), fx.legacy.result);
		assert.deepEqual(tree(root), fx.legacy.after);
	});
});

describe("finding notes", () => {
	const input = (pdf: string, markdown = "text") => ({
		subject: "Anatomy",
		courseId: "c1",
		created: "2026-11-05",
		topics: [{ mid: "c1-heart", title: "Heart", markdown, cards: 1, tags: ["medizinstudium"] }],
		pdfs: [{ src: pdf, name: "A.pdf" }],
		figs: [],
		pdfSources: ["A.pdf"],
	});
	const pdfIn = (dir: string): string => {
		const pdf = path.join(dir, "a.pdf");
		fs.writeFileSync(pdf, "%PDF-1", "utf8");
		return pdf;
	};

	it("finds a note by its id and lists the course folders without the attachments", () => {
		const root = tmp("find");
		saveTopicNotes(root, input(pdfIn(tmp("src"))));
		assert.equal(findNoteById(root, "c1-heart"), "Anatomy/Themen/Heart.md");
		assert.equal(findNoteById(root, "c1-moc"), "Anatomy/Themen/00 Übersicht.md");
		assert.equal(findNoteById(root, "nope"), null);
		assert.deepEqual(listCourseFolders(root), ["Anatomy"]);
		assert.deepEqual(listMarkdown(root), ["Anatomy/Themen/00 Übersicht.md", "Anatomy/Themen/Heart.md", "Übersicht.md"]);
	});

	it("finds the same note again when the learner moved it", () => {
		const root = tmp("moved");
		const pdf = pdfIn(tmp("src"));
		saveTopicNotes(root, input(pdf, "first"));
		fs.mkdirSync(path.join(root, "Mine"));
		fs.renameSync(path.join(root, "Anatomy/Themen/Heart.md"), path.join(root, "Mine/My heart.md"));
		const res = saveTopicNotes(root, input(pdf, "second"));
		assert.equal(res.notes[0]!.created, false);
		assert.ok(fs.readFileSync(path.join(root, "Mine/My heart.md"), "utf8").includes("second"));
		assert.equal(fs.existsSync(path.join(root, "Anatomy/Themen/Heart.md")), false, "no second copy");
	});
});

describe("files that are not text", () => {
	it("are neither read as notes nor rewritten", async () => {
		const root = tmp("binary");
		fs.mkdirSync(path.join(root, "Anatomy/Themen"), { recursive: true });
		const bytes = Buffer.concat([Buffer.from("---\nmedanki_id: x-1\n---\n\n# Broken\n\n## Eigene Notizen\n\n"), Buffer.from([0xff, 0xfe, 0xe4]), Buffer.from("\n")]);
		fs.writeFileSync(path.join(root, "Anatomy/Themen/Broken.md"), bytes);
		fs.writeFileSync(path.join(root, "Anatomy/Themen/A.md"), "---\nmedanki_id: x-2\n---\n\n# A\n\n**Costa** ribs\n\n## Eigene Notizen\n\n");
		assert.deepEqual(
			scanNotes(root).map((n) => n.title),
			["A"],
		);
		assert.equal(unlinkVault(root), 0);
		assert.deepEqual(fs.readFileSync(path.join(root, "Anatomy/Themen/Broken.md")), bytes);
		await assert.rejects(() => linkVault(root, { useLlm: false }, deps()), /fewer than two notes/);
	});
});

describe("linking with Claude", () => {
	const setup = () => {
		const root = tmp("llm");
		fs.mkdirSync(path.join(root, "Anatomy/Themen"), { recursive: true });
		fs.mkdirSync(path.join(root, "Physiology/Themen"), { recursive: true });
		const note = (id: string, fach: string, title: string, body: string) => `---\nfach: "${fach}"\ntags:\n  - medizinstudium\nmedanki_id: ${id}\n---\n\n# ${title}\n\n${body}\n\n## Eigene Notizen\n\n`;
		fs.writeFileSync(path.join(root, "Anatomy/Themen/Heart.md"), note("a-1", "Anatomy", "Heart", "> [!abstract] Kernaussagen\n> - **Atrium** and **ventricle**\n\n## Cardiac chambers\n- **Valves** regulate flow"));
		fs.writeFileSync(path.join(root, "Physiology/Themen/Valves.md"), note("p-1", "Physiology", "Valves", "> [!abstract] Kernaussagen\n> - **Valves** regulate **cardiac** flow\n\n## Cardiac valves\n- **Atrium** pressure and **ventricle** filling"));
		return root;
	};

	it("writes the links Claude picked, with Claude's reasons", async () => {
		const root = setup();
		let model = "";
		const ask: AskClaude = async (req) => {
			model = req.model;
			return { text: JSON.stringify({ links: [{ id: "n1", to: [{ id: "n2", why: "same valves, clinical view" }] }] }), costUsd: 0, durationMs: 1 };
		};
		const res = await linkVault(root, { useLlm: true }, deps({ ask }));
		assert.equal(model, "haiku");
		assert.equal(res.llm, true);
		assert.equal(res.llmFailed, 0);
		assert.equal(res.links, 1);
		const heart = fs.readFileSync(path.join(root, "Anatomy/Themen/Heart.md"), "utf8");
		assert.ok(heart.includes("- [[Physiology/Themen/Valves|Valves]] (Physiology) – same valves, clinical view"));
		const valves = fs.readFileSync(path.join(root, "Physiology/Themen/Valves.md"), "utf8");
		assert.ok(valves.includes("- [[Anatomy/Themen/Heart|Heart]] (Anatomy) – same valves, clinical view"), "the way back");
		assert.ok(valves.indexOf("## Verwandte Themen") < valves.indexOf("## Eigene Notizen"));
	});

	it("falls back to the similarity where Claude is not signed in, and says so", async () => {
		const root = setup();
		const ask: AskClaude = async () => {
			throw new ClaudeAskError("Not signed in", "auth");
		};
		const res = await linkVault(root, { useLlm: true }, deps({ ask }));
		assert.equal(res.llmFailed, 1);
		assert.equal(res.links, 1);
		assert.match(fs.readFileSync(path.join(root, "Anatomy/Themen/Heart.md"), "utf8"), /gemeinsame Begriffe: /);
	});

	it("takes a batch Claude answered with nothing as 'no links' (not as a failure)", async () => {
		const root = setup();
		const ask: AskClaude = async () => ({ text: '{"links": []}', costUsd: 0, durationMs: 1 });
		const res = await linkVault(root, { useLlm: true }, deps({ ask }));
		assert.equal(res.llmFailed, 0);
		assert.equal(res.links, 0);
		assert.equal(fs.readFileSync(path.join(root, "Anatomy/Themen/Heart.md"), "utf8").includes("Verwandte Themen"), false);
	});

	it("refuses a vault that does not exist, with a clear message", async () => {
		await assert.rejects(() => linkVault(path.join(tmp("none"), "missing"), { useLlm: false }, deps()), /does not exist yet/);
	});
});

describe("where the vault is", () => {
	it("is the learner's choice, then LH_VAULT_DIR, then ~/Documents/Medizinstudium", () => {
		const dir = tmp("settings");
		const file = path.join(dir, "vault.json");
		const plain = createVaultSettings(file, { home: "/home/x" });
		assert.deepEqual(plain.location(), { path: "/home/x/Documents/Medizinstudium", custom: false, defaultPath: "/home/x/Documents/Medizinstudium" });
		const env = createVaultSettings(file, { home: "/home/x", env: "/srv/vault" });
		assert.deepEqual([env.location().path, env.location().custom], ["/srv/vault", false]);
		env.setPath("~/Notes");
		assert.deepEqual([env.location().path, env.location().custom], ["/home/x/Notes", true]);
		env.setPath("");
		assert.deepEqual([env.location().path, env.location().custom], ["/srv/vault", false]);
	});

	it("refuses a relative path and a file", () => {
		const dir = tmp("settings");
		const s = createVaultSettings(path.join(dir, "vault.json"), { home: dir });
		assert.throws(() => s.setPath("Notes/vault"), VaultPathError);
		fs.writeFileSync(path.join(dir, "a-file"), "x");
		assert.throws(() => s.setPath(path.join(dir, "a-file")), /file, not a folder/);
	});

	it("keeps the last linking result next to the path", () => {
		const dir = tmp("settings");
		const s = createVaultSettings(path.join(dir, "vault.json"), { home: dir });
		assert.equal(s.lastLink(), null);
		const result = { notes: 3, own: 2, linked: 3, links: 2, written: 2, removed: 0, llm: false, llmFailed: 0, colors: true, at: "2026-11-05T09:08:07" };
		s.saveLink(result);
		s.setPath(dir);
		assert.deepEqual(s.lastLink(), result);
		assert.equal(s.location().path, dir);
	});

	it("survives a damaged file", () => {
		const dir = tmp("settings");
		const file = path.join(dir, "vault.json");
		fs.writeFileSync(file, "{not json");
		const s = createVaultSettings(file, { home: dir });
		assert.equal(s.location().custom, false);
		assert.equal(s.lastLink(), null);
	});
});

describe("the note set on disk", () => {
	it("is read back as written, one folder per course, with a folder for the figures", () => {
		const store = createNotesStore(tmp("notes"));
		assert.equal(store.read("c1"), null);
		const doc = store.update("c1", (d) => Object.assign(d, { status: "done", name: "Anatomy" }));
		assert.equal(doc.status, "done");
		assert.deepEqual(store.read("c1"), { ...emptyNotesDoc(), status: "done", name: "Anatomy" });
		assert.ok(fs.statSync(store.figsDir("c1")).isDirectory());
		store.remove("c1");
		assert.equal(store.read("c1"), null);
	});
	it("refuses an id that is no plain name", () => {
		const store = createNotesStore(tmp("notes"));
		assert.throws(() => store.update("../x", () => undefined), /invalid course id/);
	});
});
