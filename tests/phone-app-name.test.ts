/** The phone app's visible name (Learnbox 2.0): the home-screen label, the tab title and the web-app title. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { metadata } from "../app/m/layout.tsx";

describe("the phone app's name", () => {
	it("is Learnbox 2.0 on the home screen and in the tab", () => {
		const manifest = JSON.parse(readFileSync(new URL("../public/m/manifest.webmanifest", import.meta.url), "utf8")) as { name: string; short_name: string; id: string; start_url: string };
		assert.equal(manifest.name, "Learnbox 2.0");
		assert.equal(manifest.short_name, "Learnbox 2.0");
		// the install identity does not depend on the name: an already installed phone app stays the same app
		assert.equal(manifest.id, "/m");
		assert.equal(manifest.start_url, "/m");
		assert.equal(metadata.title, "Learnbox 2.0");
		assert.equal((metadata.appleWebApp as { title: string }).title, "Learnbox 2.0");
	});
});
