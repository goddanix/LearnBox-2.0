/**
 * The linking of a vault is MedAnki's: tests/fixtures/medanki-vault.json holds what MedAnki's own linker.py produces
 * for a small vault (regenerate with tests/fixtures/gen-medanki-vault.py) — the notes it reads with their weights, the
 * similarity candidates, the final links and the "Verwandte Themen" blocks. Below that: the parts Learnbox added
 * (the check by Claude as plain functions around the model call).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	addPicks,
	BATCH,
	blockBody,
	buildLinks,
	CANDIDATES,
	COMMON_DF,
	linkSources,
	linkSummary,
	MAX_LINKS,
	MIN_SHARED,
	MIN_SIM,
	MIN_SIM_NO_LLM,
	parseLinkPicks,
	parseNote,
	PICK,
	pickBySimilarity,
	reason,
	SAME_DOC_FACTOR,
	similarities,
	STOP,
	type Candidate,
	type Picked,
	type VaultNote,
} from "../src/core/vault-link.ts";
import { byPathParts, INDEX_NAME } from "../src/core/vault-text.ts";
import { linkPrompt } from "../src/agent/create/notes-prompts.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/medanki-vault.json", import.meta.url), "utf8"));
const lk = fx.linker;

/** What the store does: the notes of a vault in MedAnki's scan order. */
function scan(files: Record<string, string>): VaultNote[] {
	const notes: VaultNote[] = [];
	for (const file of Object.keys(files).sort(byPathParts)) {
		const parts = file.split("/");
		if (parts.some((p) => p.startsWith(".")) || parts[parts.length - 1] === INDEX_NAME) continue;
		const n = parseNote(files[file]!, file, notes.length + 1);
		if (n) notes.push(n);
	}
	return notes;
}

const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

describe("the limits", () => {
	it("are MedAnki's", () => {
		const c = fx.constants.linker;
		assert.deepEqual(
			[MAX_LINKS, CANDIDATES, PICK, BATCH, MIN_SIM, MIN_SIM_NO_LLM, MIN_SHARED, SAME_DOC_FACTOR, COMMON_DF],
			[c.MAX_LINKS, c.CANDIDATES, c.PICK, c.BATCH, c.MIN_SIM, c.MIN_SIM_NO_LLM, c.MIN_SHARED, c.SAME_DOC_FACTOR, c.COMMON_DF],
		);
		assert.deepEqual([...STOP].sort(), fx.constants.stop);
	});
});

describe("reading the notes", () => {
	const notes = scan(lk.files);

	it("finds the same notes, in the same order, as MedAnki", () => {
		assert.deepEqual(
			notes.map((n) => [n.id, n.rel, n.title, n.subject, n.doc, n.ix, n.owned, n.abstract, n.terms]),
			lk.notes.map((n: { id: string; rel: string; title: string; subject: string; doc: string; ix: number | null; owned: boolean; abstract: string; terms: string[] }) => [n.id, n.rel, n.title, n.subject, n.doc, n.ix, n.owned, n.abstract, n.terms]),
		);
	});
	it("weighs the words the same way, in the same order", () => {
		notes.forEach((n, i) => assert.deepEqual([...n.weights], Object.entries(lk.notes[i].weights)));
	});
	it("leaves out the overview note of a course and the index of the vault", () => {
		assert.equal(notes.some((n) => n.rel.includes("Übersicht")), false);
		assert.equal(parseNote("---\nmedanki_moc: true\n---\n\n# X\n", "A/B/X.md", 1), null);
	});
	it("does not let its own links strengthen themselves", () => {
		const sternum = notes.find((n) => n.title === "Sternum")!;
		assert.ok(sternum.text.includes("## Verwandte Themen"), "the text keeps the block");
		assert.equal(sternum.weights.has("ribs"), false, "the words of the block are not counted");
	});
});

describe("similarity", () => {
	const notes = scan(lk.files);
	const cands = similarities(notes);

	it("gives MedAnki's candidates, best first", () => {
		assert.deepEqual([...cands.keys()], Object.keys(lk.candidates));
		for (const [id, list] of cands) {
			const want = lk.candidates[id] as { id: string; score: number; shared: string[] }[];
			assert.deepEqual(
				list.map((c) => [c.id, c.shared]),
				want.map((c) => [c.id, c.shared]),
			);
			list.forEach((c, i) => near(c.score, want[i]!.score, `${id}→${c.id}`));
		}
	});
	it("skips the direct neighbours of one script", () => {
		assert.deepEqual(cands.get("n1"), []);
		assert.deepEqual(cands.get("n2"), []);
	});
	it("reasons from the shared terms", () => {
		assert.equal(reason(["a", "b", "c", "d"]), lk.reason);
	});
});

describe("the links", () => {
	const notes = scan(lk.files);
	const cands = similarities(notes);
	const byId = new Map(notes.map((n) => [n.id, n]));
	const picked: Picked = new Map(Object.entries(lk.picked as Record<string, Record<string, string>>).map(([k, v]) => [k, new Map(Object.entries(v))]));

	it("are mutual where the other side is the app's own note, and only written for own notes", () => {
		const links = buildLinks(notes, cands, picked);
		assert.deepEqual([...links.keys()], Object.keys(lk.links));
		for (const [id, rows] of links) {
			const want = lk.links[id] as { id: string; why: string; score: number }[];
			assert.deepEqual(rows.map((r) => [r.id, r.why]), want.map((r) => [r.id, r.why]));
			rows.forEach((r, i) => near(r.score, want[i]!.score, id));
		}
		assert.equal(links.has("n4"), false, "the reader's own note is not written");
	});
	it("become the block MedAnki writes", () => {
		const links = buildLinks(notes, cands, picked);
		for (const [id, rows] of links) assert.equal(blockBody(rows, byId), lk.blocks[id]);
	});
	it("take at most MAX_LINKS, the chosen ones first", () => {
		const mk = (id: string, owned: boolean): VaultNote => ({ id, rel: id, file: `${id}.md`, title: id, subject: "S", doc: "", ix: null, owned, abstract: "", terms: [], weights: new Map(), text: "" });
		const many = Array.from({ length: 9 }, (_, i) => mk(`n${i + 1}`, i === 0));
		const cs = new Map<string, Candidate[]>([["n1", many.slice(1).map((n, i) => ({ id: n.id, score: 0.9 - i * 0.05, shared: ["x", "y"] }))]]);
		// the last two are the best by score but not chosen: nothing is chosen for them, so they only come back as the way back
		const pick: Picked = new Map([["n1", new Map(many.slice(1).map((n) => [n.id, "why"]))]]);
		const out = buildLinks(many, cs, pick).get("n1")!;
		assert.equal(out.length, MAX_LINKS);
		assert.deepEqual(out.map((r) => r.id), ["n2", "n3", "n4", "n5", "n6", "n7"]);
	});
	it("count the pairs including those to the reader's own notes", () => {
		const links = buildLinks(notes, cands, picked);
		const sum = linkSummary(notes, links, picked);
		assert.deepEqual(sum, { notes: 5, own: 4, linked: 2, links: 1 });
	});
});

describe("the check by Claude", () => {
	const notes = scan(lk.files);
	const cands = similarities(notes);
	const byId = new Map(notes.map((n) => [n.id, n]));

	it("shows the model the candidates the way MedAnki does", () => {
		const sources = linkSources([byId.get("n3")!, byId.get("n5")!], cands, byId);
		assert.equal(sources.length, 2);
		assert.deepEqual(Object.keys(sources[0]!), ["id", "title", "subject", "doc", "abstract", "terms", "cands"]);
		assert.deepEqual(Object.keys(sources[0]!.cands[0]!), ["id", "title", "subject", "doc", "terms", "score"]);
		assert.ok(linkPrompt(sources).includes("### Quellnotiz [n3] „Heart“"));
	});

	it("takes only the picks of candidates that were offered, at most PICK per source, and cleans the reason", () => {
		const sources = [{ id: "n1", cands: [{ id: "n2" }, { id: "n3" }] }, { id: "n9", cands: [] }];
		const raw = {
			links: [
				{ id: "n1", to: [{ id: "n2", why: "  same\n thorax " }, { id: "n7", why: "ghost" }, "x", { id: "n3" }, { id: "n3", why: "x".repeat(200) }] },
				{ id: "n5", to: [{ id: "n2", why: "unknown source" }] },
				"x",
				{ id: "n9", to: "no" },
			],
		};
		const out = parseLinkPicks(raw, sources);
		assert.deepEqual([...out.keys()], ["n1"]);
		assert.deepEqual([...out.get("n1")!.keys()], ["n2", "n3"]);
		assert.equal(out.get("n1")!.get("n2"), "same thorax");
		assert.equal(out.get("n1")!.get("n3")?.length, 90);
		assert.equal(parseLinkPicks("no", sources).size, 0);
		assert.equal(parseLinkPicks({ links: "no" }, sources).size, 0);
		const six = parseLinkPicks({ links: [{ id: "n1", to: Array.from({ length: 8 }, () => ({ id: "n2", why: "w" })) }] }, sources);
		assert.equal(six.get("n1")!.size, 1);
	});

	it("falls back to the choice by similarity above the stricter bar", () => {
		const picked: Picked = new Map();
		pickBySimilarity([byId.get("n3")!, byId.get("n1")!], cands, picked);
		assert.deepEqual([...picked.get("n3")!.keys()], ["n5", "n4"]);
		assert.equal(picked.get("n3")!.get("n5"), "gemeinsame Begriffe: ventricle, cardiac, atrium");
		assert.equal(picked.has("n1"), false);
	});

	it("fills an empty reason from the shared terms", () => {
		const picked: Picked = new Map();
		addPicks(picked, new Map([["n3", new Map([["n5", ""], ["n4", "own words"]])], ["n1", new Map()]]), cands);
		assert.equal(picked.get("n3")!.get("n5"), "gemeinsame Begriffe: ventricle, cardiac, atrium");
		assert.equal(picked.get("n3")!.get("n4"), "own words");
		assert.equal(picked.has("n1"), false);
	});
});
