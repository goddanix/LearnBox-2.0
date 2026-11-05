/**
 * The two routes that take answers from a phone (Learnbox 2.0, Slice 10d), on the real stores in a temp data dir:
 * POST /api/phone/sync (the update's upload, through the gateway) and POST /api/mobile/backup (a backup file read in
 * on the Mac, Settings only). LH_DATA_DIR is set BEFORE the first import (config.ts reads it at load).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { StudyCard, StudyCourse } from "../src/core/contracts/study.ts";
import { buildPhoneBackup } from "../src/core/phone-sync.ts";
import { mobileRoute } from "../src/core/mobile.ts";

const NOW = new Date(2026, 10, 5, 19, 52, 7);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-sync-routes-"));
process.env.LH_DATA_DIR = dir;

const course: StudyCourse = { id: "k1", name: "k1", bufferDays: 5, createdAt: NOW.toISOString() };
const card = (id: string): StudyCard => ({ id, courseId: "k1", kind: "basic", fields: { Front: `Q-${id}`, Back: `A-${id}` }, tags: [], core: false, origin: { kind: "manual" }, createdAt: NOW.toISOString() });
const line = (cardId: string, at: string, grade = 3) => ({ cardId, at, grade });

let sync: typeof import("../app/api/phone/sync/route.ts");
let backup: typeof import("../app/api/mobile/backup/route.ts");
let reviews: () => number;

const post = (url: string, body: unknown) => new Request(`http://test${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

before(async () => {
	const { studyStore } = await import("../src/store/study.ts");
	studyStore.upsertCourse(course);
	studyStore.upsertCards([card("c1"), card("c2")]);
	reviews = () => studyStore.readReviews().length;
	sync = await import("../app/api/phone/sync/route.ts");
	backup = await import("../app/api/mobile/backup/route.ts");
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("POST /api/phone/sync", () => {
	it("takes the answers in once and says what it did", async () => {
		const body = { reviews: [line("c1", "2026-11-05T09:00:00.000Z"), line("c2", "2026-11-05T09:01:00.000Z", 2), line("gone", "2026-11-05T09:02:00.000Z")] };
		const first = await sync.POST(post("/api/phone/sync", body));
		assert.equal(first.status, 200);
		assert.deepEqual(await first.json(), { added: 2, known: 0, unknownCards: 1, rejected: 0, reviewsTotal: 2 });
		const again = await (await sync.POST(post("/api/phone/sync", body))).json();
		assert.equal(again.added, 0);
		assert.equal(again.known, 2);
		assert.equal(reviews(), 2);
	});

	it("answers 400 with a message for something that is not a list of answers", async () => {
		for (const bad of [{}, { reviews: "x" }, [], "not json {"]) {
			const res = await sync.POST(post("/api/phone/sync", bad));
			assert.equal(res.status, 400, JSON.stringify(bad));
			assert.match((await res.json()).error, /answers|JSON/i);
		}
	});
});

describe("POST /api/mobile/backup", () => {
	it("reads a backup file in, once, and counts the lines it could not read", async () => {
		const file = { ...buildPhoneBackup([{ cardId: "c1", at: "2026-11-05T10:00:00.000Z", grade: 4 }], NOW, "iPhone"), reviews: [{ cardId: "c1", at: "2026-11-05T10:00:00.000Z", grade: 4 }, { nonsense: 1 }] };
		const before = reviews();
		const res = await backup.POST(post("/api/mobile/backup", file));
		assert.equal(res.status, 200);
		const out = await res.json();
		assert.equal(out.added, 1);
		assert.equal(out.rejected, 1);
		assert.equal(reviews(), before + 1);
		assert.equal((await (await backup.POST(post("/api/mobile/backup", file))).json()).added, 0);
	});

	it("answers 400 for a file that is not a Learnbox phone backup", async () => {
		for (const bad of [{ v: 1 }, [], "nope {", { v: 1, kind: "learnbox-phone-backup" }]) {
			const res = await backup.POST(post("/api/mobile/backup", bad));
			assert.equal(res.status, 400, JSON.stringify(bad));
			assert.match((await res.json()).error, /not a Learnbox phone backup/);
		}
	});

	it("is for the Mac's settings only: the phone's gateway does not let it through", () => {
		assert.equal(mobileRoute("POST", "/api/mobile/backup"), "deny");
		assert.equal(mobileRoute("POST", "/api/phone/sync"), "device");
	});
});
