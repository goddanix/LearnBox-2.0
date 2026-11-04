import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LegacyImport } from "../components/create/legacy-import.tsx";
import { NewJobForm } from "../components/create/new-job-form.tsx";
import type { LectureSource } from "../src/core/contracts.ts";

/**
 * The Create area's static surface (Learnbox 2.0, 2026-11): the new-job form's
 * controls and its "other PDF" choice, and the MedAnki import's dry-run-first
 * entry. Server-rendered, no network.
 */

const lecture = (id: string, title: string): LectureSource => ({
	v: 1,
	id,
	title,
	fileName: `${title}.pdf`,
	bytes: 1000,
	sha256: id,
	pages: 12,
	addedAt: "2026-11-04T10:00:00.000Z",
	status: "stored",
});

const noop = () => {};

describe("NewJobForm", () => {
	it("names the PDF and offers the settings, with English as the default language", () => {
		const html = renderToStaticMarkup(
			<NewJobForm lecture={lecture("a", "Vertebrae")} lectures={[lecture("a", "Vertebrae")]} onCreated={noop} onCancel={noop} />,
		);
		assert.match(html, /Multiple-choice test from <span[^>]*>Vertebrae<\/span>/);
		assert.match(html, /Questions per page/);
		assert.match(html, /<option value="en" selected="">English<\/option>/);
		assert.match(html, /<option value="de">German<\/option>/);
		assert.match(html, /To page \(0 = end\)/);
		assert.match(html, /Create questions/);
		assert.match(html, /Nothing is added to your cards until you adopt it/);
	});

	it("offers only OTHER library PDFs as the fact source, and none when there is no other", () => {
		const a = lecture("a", "Question sheet");
		const html = renderToStaticMarkup(<NewJobForm lecture={a} lectures={[a, lecture("b", "Lecture slides")]} onCreated={noop} onCancel={noop} />);
		assert.match(html, /<option value="b">Lecture slides<\/option>/);
		assert.doesNotMatch(html, /<option value="a">/);
		assert.match(html, /Facts from another PDF/);

		const alone = renderToStaticMarkup(<NewJobForm lecture={a} lectures={[a]} onCreated={noop} onCancel={noop} />);
		assert.doesNotMatch(alone, /Facts from another PDF/);
	});

	it("limits the page inputs to the PDF's pages", () => {
		const html = renderToStaticMarkup(<NewJobForm lecture={lecture("a", "X")} lectures={[]} onCreated={noop} onCancel={noop} />);
		assert.match(html, /max="12"/);
	});
});

describe("LegacyImport", () => {
	it("starts closed and does nothing until Check is pressed", () => {
		const html = renderToStaticMarkup(<LegacyImport onImported={noop} />);
		assert.match(html, /<details[^>]*data-testid="legacy-import"/);
		assert.doesNotMatch(html, /<details[^>]* open/);
		assert.match(html, /MedAnki itself is not changed/);
		assert.match(html, /data-testid="legacy-check"/);
		assert.doesNotMatch(html, /legacy-import-button/);
		assert.doesNotMatch(html, /legacy-jobs/);
	});
});
