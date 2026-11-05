/**
 * What is written into an Obsidian vault is MedAnki's: tests/fixtures/medanki-vault.json holds what MedAnki's own
 * Python code produces (regenerate with tests/fixtures/gen-medanki-vault.py) — the text rules that protect a note,
 * the frontmatter, the related-topics block, the graph colours.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	ASSETS,
	frontmatterId,
	graphColorsFile,
	INDEX_NAME,
	LINKS_HEADING,
	MOC_NAME,
	obsidianUrl,
	OWN_HEADING,
	removeLinksBlock,
	safeName,
	SAVE_DIR,
	setBody,
	setLinksBlock,
	slug,
	stripLegacyMarkers,
	topicFrontmatter,
} from "../src/core/vault-text.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/medanki-vault.json", import.meta.url), "utf8"));
const rules = fx.textRules;

describe("the names of the vault", () => {
	it("match MedAnki's", () => {
		assert.equal(OWN_HEADING, fx.constants.vault.OWN_HEADING);
		assert.equal(LINKS_HEADING, fx.constants.vault.LINKS_HEADING);
		assert.equal(INDEX_NAME, fx.constants.vault.INDEX_NAME);
		assert.equal(SAVE_DIR, fx.constants.vault.SAVE_DIR);
		assert.equal(MOC_NAME, fx.constants.vault.MOC_NAME);
		assert.equal(ASSETS, fx.constants.vault.ASSETS);
	});
});

describe("file names", () => {
	it("safeName is MedAnki's", () => {
		for (const c of rules.safeName) assert.equal(safeName(c.text, c.fallback, c.max), c.out, JSON.stringify(c));
	});
	it("slug is MedAnki's", () => {
		for (const c of rules.slug) assert.equal(slug(c.text, c.max), c.out, JSON.stringify(c));
	});
});

describe("protecting a note", () => {
	it("takes the earlier visible markers off the way MedAnki does", () => {
		for (const c of rules.stripLegacy) assert.equal(stripLegacyMarkers(c.text), c.out);
	});
	it("replaces only the generated text, or reports a structure it cannot read", () => {
		assert.ok(rules.setBody.some((c: { out: string | null }) => c.out === null), "the fixture has an unreadable note");
		assert.ok(rules.setBody.some((c: { out: string | null }) => c.out !== null));
		for (const c of rules.setBody) assert.equal(setBody(c.text, c.body), c.out, JSON.stringify(c).slice(0, 200));
	});
	it("never lets the generated text carry a boundary heading", () => {
		const out = setBody("# T\n\nold\n\n## Eigene Notizen\n\nmine\n", "text\n## Eigene Notizen\nmore");
		assert.ok(out?.includes("## Eigene Notizen (Skript)"));
		assert.ok(out?.endsWith("## Eigene Notizen\n\nmine\n"));
	});
	it("reads the id of a note", () => {
		for (const c of rules.frontmatterId) assert.equal(frontmatterId(c.text), c.out);
	});
	it("writes the frontmatter of a topic note and of an overview", () => {
		for (const c of rules.topicFrontmatter) {
			const a = c.args;
			assert.equal(topicFrontmatter({ subject: a.subject, id: a.id, created: a.created, tags: a.tags, sources: a.sources, topic: a.topic, moc: a.moc }), c.out);
		}
	});
});

describe("the related-topics block", () => {
	it("is taken out the way MedAnki does", () => {
		for (const c of rules.removeLinks) assert.equal(removeLinksBlock(c.text), c.out);
	});
	it("is set the way MedAnki does", () => {
		for (const c of rules.setLinks) assert.equal(setLinksBlock(c.text, c.block), c.out);
	});
});

describe("the link to Obsidian", () => {
	it("is percent-encoded like Python's quote", () => {
		for (const c of rules.obsidianUrl) assert.equal(obsidianUrl(c.path), c.out);
		assert.equal(obsidianUrl("/a(b)!*'.md"), "obsidian://open?path=%2Fa%28b%29%21%2A%27.md");
	});
});

describe("the graph colours", () => {
	it("are written only when the reader has none", () => {
		for (const c of rules.graphColors) {
			const out = graphColorsFile(c.existing === null ? null : JSON.stringify(c.existing), c.subjects);
			if (c.out.wrote) assert.equal(out, c.out.file);
			else assert.equal(out, null, JSON.stringify(c));
		}
		assert.equal(graphColorsFile("{not json", ["A"]), null);
		assert.equal(graphColorsFile("[1]", ["A"]), null);
	});
});
