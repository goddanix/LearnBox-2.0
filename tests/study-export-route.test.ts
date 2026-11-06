/**
 * POST /api/study/export on the real stores in a temp data dir (LH_DATA_DIR is set BEFORE the first import — config.ts
 * reads it at load): the file comes back as a download, the summary travels in a header, a bad request is a JSON error.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { StudyCard, StudyCourse } from "../src/core/contracts/study.ts";

const NOW = new Date(2026, 10, 5, 19, 52, 7);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "study-export-route-"));
process.env.LH_DATA_DIR = dir;

const course: StudyCourse = { id: "anatomie", name: "Anatomie ä", bufferDays: 5, createdAt: NOW.toISOString() };
const card: StudyCard = { id: "c1", courseId: "anatomie", kind: "basic", fields: { Front: "Q", Back: "A", Extra: "", Source: "", Reverse: "" }, tags: [], core: false, origin: { kind: "manual" }, createdAt: NOW.toISOString() };

let route: typeof import("../app/api/study/export/route.ts");
const post = (body: unknown) => new Request("http://test/api/study/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

before(async () => {
	const { studyStore } = await import("../src/store/study.ts");
	studyStore.upsertCourse(course);
	studyStore.upsertCard(card);
	route = await import("../app/api/study/export/route.ts");
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("POST /api/study/export", () => {
	it("returns the package as a download with the summary in a header", async () => {
		const res = await route.POST(post({ courseIds: ["anatomie"], progress: false, subdecks: true }));
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "application/octet-stream");
		const disposition = res.headers.get("content-disposition") ?? "";
		assert.match(disposition, /^attachment; filename="Learnbox-Anatomie-_-\d{4}-\d{2}-\d{2}\.apkg"; filename\*=UTF-8''Learnbox-Anatomie-%C3%A4-\d{4}-\d{2}-\d{2}\.apkg$/);
		const summary = JSON.parse(decodeURIComponent(res.headers.get("x-learnbox-export")!));
		assert.deepEqual({ cards: summary.cards, notes: summary.notes, decks: summary.decks }, { cards: 1, notes: 1, decks: 1 });
		const bytes = Buffer.from(await res.arrayBuffer());
		assert.equal(bytes.readUInt32LE(0), 0x04034b50, "starts like a ZIP");
		assert.equal(bytes.length, summary.bytes);
	});

	it("answers a bad request with a JSON error", async () => {
		const none = await route.POST(post({ courseIds: [] }));
		assert.equal(none.status, 400);
		assert.match((await none.json()).error, /at least one course/);
		const unknown = await route.POST(post({ courseIds: ["nope"] }));
		assert.equal(unknown.status, 404);
		const garbage = await route.POST(new Request("http://test/api/study/export", { method: "POST", body: "not json" }));
		assert.equal(garbage.status, 400);
	});
});
