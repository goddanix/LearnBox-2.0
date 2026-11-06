/**
 * The widget helper's work (Learnbox 2.0, Widget): read the study ledgers, make the snapshot, write it where the
 * macOS widget looks.
 *
 * The widget (a WidgetKit extension) is sandboxed: it may read ONE small file and runs nothing, so a separate
 * helper program (scripts/widget-helper.ts, started by the widget's companion app) does the sums with the review
 * screen's own code (core/widget-snapshot.ts) and leaves the result here. READ-ONLY on the ledgers: the helper never
 * appends, rewrites or creates anything under the data folder — its only write is the snapshot file itself.
 *
 * The file is replaced atomically (temp file + rename in the same folder), so the widget never reads a torn file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { widgetSnapshot, type WidgetSnapshot } from "../core/widget-snapshot.ts";
import { createStudyStore, type StudyFiles } from "../store/study.ts";

/** Learnbox's data folder name under Application Support — pinned by the desktop shell (electron/main.cjs). */
const SUPPORT_FOLDER = "Library/Application Support/Learnbox";

export interface HelperOptions {
	/** The data folder (holds study/courses.jsonl …). */
	dataDir: string;
	/** The snapshot file to write. */
	out: string;
	/** Fixed clock for tests; the real run uses the current time. */
	now?: Date;
}

/** Where the desktop app keeps its data, and where the widget reads from, for a home folder. */
export const defaultPaths = (home: string): { dataDir: string; out: string } => ({
	dataDir: path.join(home, SUPPORT_FOLDER, "data"),
	out: path.join(home, SUPPORT_FOLDER, "widget", "widget.json"),
});

export class HelperUsageError extends Error {}

/** `--data-dir <dir> --out <file> [--now <iso>]`; anything else is refused (a typo must not write somewhere odd). */
export function parseHelperArgs(argv: readonly string[], home: string): HelperOptions {
	const paths = defaultPaths(home);
	let dataDir = paths.dataDir;
	let out = paths.out;
	let now: Date | undefined;
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) throw new HelperUsageError(`${flag} needs a value`);
		if (flag === "--data-dir") dataDir = path.resolve(value);
		else if (flag === "--out") out = path.resolve(value);
		else if (flag === "--now") {
			now = new Date(value);
			if (Number.isNaN(now.getTime())) throw new HelperUsageError(`--now is not a date: ${value}`);
		} else throw new HelperUsageError(`unknown option: ${flag}`);
	}
	return { dataDir, out, ...(now ? { now } : {}) };
}

export const studyFilesIn = (dataDir: string): StudyFiles => ({
	courses: path.join(dataDir, "study", "courses.jsonl"),
	cards: path.join(dataDir, "study", "cards.jsonl"),
	reviews: path.join(dataDir, "study", "reviews.jsonl"),
});

/** The numbers for the study ledgers under `dataDir` (no ledgers yet = no courses). */
export function snapshotFromDataDir(dataDir: string, now: Date): WidgetSnapshot {
	return widgetSnapshot(createStudyStore(studyFilesIn(dataDir)), now);
}

/** The snapshot without the time it was made — what "nothing changed" means for the widget. */
const content = (s: WidgetSnapshot): string => JSON.stringify({ ...s, generatedAt: "" });

/**
 * Write the snapshot to `file` atomically. `changed` is false when the file already held the same numbers (only the
 * time differs), so the companion can skip a needless widget reload.
 */
export function writeSnapshotFile(file: string, snapshot: WidgetSnapshot): { changed: boolean } {
	let changed = true;
	try {
		changed = content(JSON.parse(fs.readFileSync(file, "utf-8")) as WidgetSnapshot) !== content(snapshot);
	} catch {
		// no file yet, or unreadable: write it
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, { encoding: "utf-8", mode: 0o644 });
		fs.renameSync(tmp, file);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw e;
	}
	return { changed };
}

export interface HelperResult {
	changed: boolean;
	courses: number;
	due: number;
	new: number;
}

/** One helper run: ledgers in, snapshot file out. */
export function runHelper(options: HelperOptions): HelperResult {
	const snapshot = snapshotFromDataDir(options.dataDir, options.now ?? new Date());
	const { changed } = writeSnapshotFile(options.out, snapshot);
	return { changed, courses: snapshot.courses.length, due: snapshot.totals.due, new: snapshot.totals.new };
}
