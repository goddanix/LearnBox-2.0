/** The Export-to-Anki group in Settings → Study: course choice, the two switches, the request, the result lines. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { StudyExport } from "../components/settings/study-export.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document });
const originalFetch = globalThis.fetch;
const originalCreate = URL.createObjectURL;
const roots: { root: Root; host: HTMLElement }[] = [];
const q = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

const summary = { decks: 2, notes: 5, cards: 7, reviews: 12, foldedNotes: 1, media: 3, missingMedia: ["gone.png"], missingCount: 1, bytes: 2_500_000 };
const courses = [
	{ id: "anatomie", name: "Anatomie", daysLeft: null, total: 40, counts: { new: 0, learning: 0, review: 0 }, newQuota: 20 },
	{ id: "leer", name: "Leer", daysLeft: null, total: 0, counts: { new: 0, learning: 0, review: 0 }, newQuota: 20 },
	{ id: "physio", name: "Physiologie", daysLeft: null, total: 9, counts: { new: 0, learning: 0, review: 0 }, newQuota: 20 },
];

function fakeFetch(exportResponse: () => Response) {
	const posts: unknown[] = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (String(url).endsWith("/api/study/courses")) return Response.json({ courses });
		posts.push(JSON.parse(String(init?.body)));
		return exportResponse();
	}) as typeof fetch;
	return posts;
}

async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => {
		root.render(<StudyExport />);
	});
	await act(async () => {}); // the course list arrives
	return host;
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
		host.remove();
	}
	globalThis.fetch = originalFetch;
	URL.createObjectURL = originalCreate;
});

describe("StudyExport", () => {
	it("lists the courses, preselects those with cards and sends the choice", async () => {
		const posts = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-disposition": `attachment; filename="x.apkg"; filename*=UTF-8''Learnbox-Anatomie.apkg`, "x-learnbox-export": encodeURIComponent(JSON.stringify(summary)) } }));
		URL.createObjectURL = () => "blob:fake";
		const host = await mount();
		const boxes = [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
		assert.equal(boxes.length, 3);
		assert.deepEqual(boxes.map((b) => b.checked), [true, false, true]);
		assert.match(q(host, "export-run")!.textContent ?? "", /Export 2 courses/);

		await act(async () => {
			boxes[2]!.click(); // untick Physiologie
		});
		assert.match(q(host, "export-run")!.textContent ?? "", /Export 1 course…/);
		await act(async () => {
			q(host, "export-progress")!.querySelector<HTMLElement>("[role=switch]")!.click();
		});
		assert.match(q(host, "export-progress")!.textContent ?? "", /Include scheduling information/);
		await act(async () => {
			q(host, "export-run")!.click();
		});
		await act(async () => {});
		assert.deepEqual(posts, [{ courseIds: ["anatomie"], progress: true, subdecks: true }]);
		const result = q(host, "export-result")!.textContent ?? "";
		assert.match(result, /Learnbox-Anatomie\.apkg \(2\.4 MB\): 7 cards in 5 notes, 2 decks, 12 reviews, 3 picture\/audio files/);
		assert.match(result, /1 note had extra fields/);
		assert.match(result, /1 media file could not be found.*gone\.png/);
	});

	it("shows the server's refusal and exports nothing without a course", async () => {
		fakeFetch(() => Response.json({ error: "The chosen courses have no cards to export" }, { status: 400 }));
		const host = await mount();
		await act(async () => {
			q(host, "export-run")!.click();
		});
		await act(async () => {});
		assert.match(q(host, "export-error")!.textContent ?? "", /no cards to export/);
		assert.equal(q(host, "export-result"), null);
		for (const box of host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
			if (box.checked) await act(async () => box.click());
		}
		assert.equal((q(host, "export-run") as HTMLButtonElement).disabled, true);
	});
});
