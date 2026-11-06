/**
 * The widget's numbers and the helper program that writes them (core/widget-snapshot.ts, src/server/widget-file.ts,
 * scripts/widget-helper.ts). Scratch folders only: the helper is read-only on the ledgers, and these tests prove it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { StudyCard, StudyCourse, StudyReview } from "../src/core/contracts/study.ts";
import { studyCourses } from "../src/core/study-engine.ts";
import { widgetSnapshot } from "../src/core/widget-snapshot.ts";
import {
	HelperUsageError,
	defaultPaths,
	parseHelperArgs,
	runHelper,
	snapshotFromDataDir,
	studyFilesIn,
	writeSnapshotFile,
} from "../src/server/widget-file.ts";
import { createStudyStore } from "../src/store/study.ts";

const NOW = new Date(2026, 10, 4, 10, 0, 0); // 2026-11-04 10:00 local
const root = fs.mkdtempSync(path.join(os.tmpdir(), "widget-helper-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
const scratch = (): string => {
	const dir = path.join(root, `d${++n}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
};

const course = (over: Partial<StudyCourse> = {}): StudyCourse => ({
	id: "anatomie",
	name: "Anatomie",
	bufferDays: 5,
	createdAt: "2026-10-01T00:00:00.000Z",
	...over,
});
let c = 0;
const card = (courseId: string, over: Partial<StudyCard> = {}): StudyCard => ({
	id: `c${++c}`,
	courseId,
	kind: "basic",
	fields: { Front: "f", Back: "b" },
	tags: [],
	core: false,
	origin: { kind: "manual" },
	createdAt: "2026-10-01T00:00:00.000Z",
	...over,
});
const review = (cardId: string, at: Date, grade: 1 | 2 | 3 | 4 = 3): StudyReview => ({ cardId, at: at.toISOString(), grade });
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

/** A data folder with two courses: Anatomie (deadline in 20 days; reviewed + new cards) and Physiologie (all new). */
function seed(dir: string) {
	const store = createStudyStore(studyFilesIn(dir));
	store.upsertCourse(course({ deadline: "2026-11-24" }));
	store.upsertCourse(course({ id: "physio", name: "Physiologie", createdAt: "2026-10-02T00:00:00.000Z" }));
	store.upsertCourse(course({ id: "leer", name: "Leer", createdAt: "2026-10-03T00:00:00.000Z" }));
	const seen = [card("anatomie"), card("anatomie"), card("anatomie")];
	const fresh = [card("anatomie"), card("anatomie"), card("physio"), card("physio")];
	store.upsertCards([...seen, ...fresh]);
	// the three reviewed cards were last answered 30 days ago with an "again": they are due
	store.appendReviews(seen.map((s) => review(s.id, daysAgo(30), 1)));
	return store;
}

describe("widgetSnapshot", () => {
	it("shows the review screen's own numbers per course, most to do first, empty courses left out", () => {
		const dir = scratch();
		const store = seed(dir);
		const snap = widgetSnapshot(store, NOW);
		const screen = studyCourses(NOW, { store, resolve: () => null });

		for (const row of snap.courses) {
			const s = screen.find((x) => x.id === row.id);
			assert.ok(s, row.id);
			assert.equal(row.due, s.counts.learning + s.counts.review, `${row.id} due`);
			assert.equal(row.new, s.counts.new, `${row.id} new`);
			assert.equal(row.total, s.total);
			assert.equal(row.daysLeft, s.daysLeft);
		}
		assert.deepEqual(snap.courses.map((x) => x.id).sort(), ["anatomie", "physio"], "the empty course is left out");
		assert.ok(snap.courses[0]!.due + snap.courses[0]!.new >= snap.courses[1]!.due + snap.courses[1]!.new, "most to do first");
		assert.equal(snap.totals.due, snap.courses.reduce((s, x) => s + x.due, 0));
		assert.equal(snap.totals.new, snap.courses.reduce((s, x) => s + x.new, 0));
		assert.ok(snap.totals.due > 0 && snap.totals.new > 0, "the seed has something due and something new");
		assert.equal(snap.day, "2026-11-04");
		assert.equal(snap.version, 1);
		assert.equal(snap.generatedAt, NOW.toISOString());
		assert.equal(snap.courses.find((x) => x.id === "anatomie")!.deadline, "2026-11-24");
		assert.equal(snap.courses.find((x) => x.id === "physio")!.deadline, undefined);
	});

	it("has no courses when there are no ledgers yet", () => {
		const snap = snapshotFromDataDir(path.join(scratch(), "never-created"), NOW);
		assert.deepEqual(snap.courses, []);
		assert.deepEqual(snap.totals, { due: 0, new: 0 });
	});
});

describe("parseHelperArgs", () => {
	const HOME = "/Users/someone";
	it("defaults to the desktop app's data folder and the widget's file", () => {
		assert.deepEqual(parseHelperArgs([], HOME), defaultPaths(HOME));
		assert.equal(defaultPaths(HOME).dataDir, "/Users/someone/Library/Application Support/Learnbox/data");
		assert.equal(defaultPaths(HOME).out, "/Users/someone/Library/Application Support/Learnbox/widget/widget.json");
	});
	it("takes --data-dir, --out and --now", () => {
		const o = parseHelperArgs(["--data-dir", "/a/b", "--out", "/c/d.json", "--now", "2026-11-04T09:00:00Z"], HOME);
		assert.equal(o.dataDir, "/a/b");
		assert.equal(o.out, "/c/d.json");
		assert.equal(o.now?.toISOString(), "2026-11-04T09:00:00.000Z");
	});
	it("refuses unknown options, missing values and bad dates", () => {
		assert.throws(() => parseHelperArgs(["--wipe", "1"], HOME), HelperUsageError);
		assert.throws(() => parseHelperArgs(["--out"], HOME), HelperUsageError);
		assert.throws(() => parseHelperArgs(["--out", "--now"], HOME), HelperUsageError);
		assert.throws(() => parseHelperArgs(["--now", "yesterday-ish"], HOME), HelperUsageError);
	});
});

describe("writeSnapshotFile", () => {
	it("creates the folder, writes atomically (no temp file left) and reports a change only when the numbers changed", () => {
		const dir = scratch();
		const file = path.join(dir, "deep", "er", "widget.json");
		const a = widgetSnapshot(seed(scratch()), NOW);

		assert.equal(writeSnapshotFile(file, a).changed, true, "first write");
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), a);
		assert.deepEqual(fs.readdirSync(path.dirname(file)), ["widget.json"], "no temp file left behind");

		const later = { ...a, generatedAt: new Date(NOW.getTime() + 60_000).toISOString() };
		assert.equal(writeSnapshotFile(file, later).changed, false, "only the time differs");
		assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).generatedAt, later.generatedAt, "the file is still refreshed");

		const more = { ...later, totals: { due: later.totals.due + 1, new: later.totals.new } };
		assert.equal(writeSnapshotFile(file, more).changed, true);
	});

	it("rewrites a corrupt snapshot file", () => {
		const file = path.join(scratch(), "widget.json");
		fs.writeFileSync(file, "{ torn");
		const snap = widgetSnapshot(seed(scratch()), NOW);
		assert.equal(writeSnapshotFile(file, snap).changed, true);
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), snap);
	});
});

describe("runHelper / scripts/widget-helper.ts", () => {
	const snapshotOf = (dir: string) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());

	it("is read-only on the ledgers: the data folder is byte-identical and no file appears in it", () => {
		const data = scratch();
		seed(data);
		const before = new Map<string, { bytes: string; mtime: number }>();
		for (const e of snapshotOf(data)) {
			const f = path.join(e.parentPath, e.name);
			before.set(f, { bytes: fs.readFileSync(f, "utf-8"), mtime: fs.statSync(f).mtimeMs });
		}
		const out = path.join(scratch(), "widget", "widget.json");
		const r = runHelper({ dataDir: data, out, now: NOW });

		assert.equal(r.courses, 2);
		assert.ok(r.due > 0 && r.new > 0);
		const after = snapshotOf(data).map((e) => path.join(e.parentPath, e.name));
		assert.deepEqual(after.sort(), [...before.keys()].sort(), "no file created or removed in the data folder");
		for (const [f, was] of before) {
			assert.equal(fs.readFileSync(f, "utf-8"), was.bytes, f);
			assert.equal(fs.statSync(f).mtimeMs, was.mtime, `${f} was not touched`);
		}
		assert.equal(JSON.parse(fs.readFileSync(out, "utf-8")).totals.due, r.due);
	});

	it("runs as a program: one JSON line on stdout, the snapshot on disk", () => {
		const data = scratch();
		seed(data);
		const out = path.join(scratch(), "widget.json");
		const run = spawnSync(
			process.execPath,
			["--import", "tsx", "scripts/widget-helper.ts", "--data-dir", data, "--out", out, "--now", NOW.toISOString()],
			{ encoding: "utf-8", env: { ...process.env, NODE_ENV: "test" } },
		);
		assert.equal(run.status, 0, run.stderr);
		const line = JSON.parse(run.stdout.trim());
		assert.equal(line.ok, true);
		assert.equal(line.courses, 2);
		assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf-8")), snapshotFromDataDir(data, NOW));
	});

	it("exits 2 on a usage error and writes nothing", () => {
		const out = path.join(scratch(), "widget.json");
		const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/widget-helper.ts", "--out", out, "--wipe", "yes"], {
			encoding: "utf-8",
			env: { ...process.env, NODE_ENV: "test" },
		});
		assert.equal(run.status, 2);
		assert.equal(JSON.parse(run.stderr.trim()).ok, false);
		assert.equal(fs.existsSync(out), false);
	});
});
