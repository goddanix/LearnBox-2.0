/**
 * The Swift side of the widget (widget/Shared/Snapshot.swift) reads what the TypeScript helper writes: the very same
 * model file is compiled into a small tool here and pointed at real snapshots. macOS with swiftc only (skipped elsewhere).
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { StudyCard, StudyCourse, StudyReview } from "../src/core/contracts/study.ts";
import { runHelper, snapshotFromDataDir, studyFilesIn } from "../src/server/widget-file.ts";
import { createStudyStore } from "../src/store/study.ts";

const NOW = new Date(2026, 10, 4, 10, 0, 0);
const hasSwiftc = process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status === 0;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "widget-swift-"));
const tool = path.join(root, "decode-check");
const WIDGET = path.resolve(import.meta.dirname, "..", "widget");

const decode = (file: string) => spawnSync(tool, [file], { encoding: "utf-8" });

before(
	() => {
		if (!hasSwiftc) return;
		fs.copyFileSync(path.join(WIDGET, "Tests", "decode-check.swift"), path.join(root, "main.swift"));
		execFileSync("swiftc", ["-O", path.join(WIDGET, "Shared", "Snapshot.swift"), path.join(root, "main.swift"), "-o", tool], { stdio: "pipe" });
	},
	{ timeout: 240_000 },
);
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe("widget snapshot, read by the Swift model", { skip: !hasSwiftc && "needs macOS with swiftc" }, () => {
	it("decodes a real snapshot from the helper, numbers equal", () => {
		const data = path.join(root, "data");
		const store = createStudyStore(studyFilesIn(data));
		const course = (over: Partial<StudyCourse>): StudyCourse => ({ id: "a", name: "Anatomie ä", bufferDays: 5, createdAt: "2026-10-01T00:00:00.000Z", ...over });
		store.upsertCourse(course({ deadline: "2026-11-24" }));
		store.upsertCourse(course({ id: "p", name: "Physiologie" })); // no deadline: daysLeft null in the file
		const card = (id: string, courseId: string): StudyCard => ({ id, courseId, kind: "basic", fields: { Front: "f", Back: "b" }, tags: [], core: false, origin: { kind: "manual" }, createdAt: "2026-10-01T00:00:00.000Z" });
		store.upsertCards([card("c1", "a"), card("c2", "a"), card("c3", "a"), card("c4", "p")]);
		const old: StudyReview = { cardId: "c1", at: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(), grade: 1 };
		store.appendReview(old);

		const out = path.join(root, "out", "widget.json");
		runHelper({ dataDir: data, out, now: NOW });
		const expected = snapshotFromDataDir(data, NOW);
		const first = expected.courses[0]!;

		const run = decode(out);
		assert.equal(run.status, 0, run.stderr);
		assert.equal(
			run.stdout.trim(),
			`courses=${expected.courses.length} due=${expected.totals.due} new=${expected.totals.new} day=${expected.day} first=${first.id}:${first.due}:${first.new}:${first.daysLeft ?? "-"} generatedAt=${Math.floor(NOW.getTime() / 1000)} version=1`,
		);
		assert.ok(expected.courses.some((c) => c.daysLeft === null), "the fixture really has a course without exam days");
	});

	it("reads times with and without fractional seconds, null days and a missing deadline", () => {
		const file = path.join(root, "hand.json");
		fs.writeFileSync(file, JSON.stringify({ version: 1, generatedAt: "2026-11-06T07:44:24Z", day: "2026-11-06", courses: [{ id: "x", name: "X", due: 3, new: 4, total: 9, daysLeft: null }], totals: { due: 3, new: 4 } }));
		const run = decode(file);
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, new RegExp(`first=x:3:4:- generatedAt=${Date.UTC(2026, 10, 6, 7, 44, 24) / 1000} `));
	});

	it("reports a newer format version (the widget then asks for an update) and refuses a torn file", () => {
		const newer = path.join(root, "newer.json");
		fs.writeFileSync(newer, JSON.stringify({ version: 2, generatedAt: "2026-11-06T07:44:24.000Z", day: "2026-11-06", courses: [], totals: { due: 0, new: 0 } }));
		assert.match(decode(newer).stdout, /version=2/);

		const torn = path.join(root, "torn.json");
		fs.writeFileSync(torn, '{"version":1,"gener');
		const run = decode(torn);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /decode failed/);
	});
});
