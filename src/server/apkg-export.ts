/**
 * The .apkg export, wired (Learnbox 2.0, 2026-11): plan the rows (core/apkg.ts), write them into a SQLite collection
 * (schema 11, the layout every Anki since 2.1 imports), add the media files and pack the lot into a ZIP.
 *
 * READ-ONLY toward the study ledgers and the media folder; the only thing written is a throw-away temp folder for the
 * SQLite file. Nothing here touches Anki: the learner imports the downloaded file themself (File → Import).
 *
 * node:sqlite is loaded on first use (this module sits behind the server barrel, which every route imports);
 * `getBuiltinModule` also keeps the bundler out of it. The ZIP writer is minimal on purpose — stored/deflated entries,
 * no ZIP64 — and refuses packages that would need more; `zlib.crc32` ships with Node ≥ 22.2 (Electron's own Node).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { collectionJson, planApkg, type ApkgExportSummary, type ApkgPlan } from "../core/apkg.ts";
import { localDay } from "../core/study-queue.ts";
import { StudyInputError, defaultStudyDeps, type StudyDeps } from "./study.ts";

type Sqlite = typeof import("node:sqlite");
const sqlite = (): Sqlite => process.getBuiltinModule("node:sqlite") as Sqlite;

/** The package must stay a plain (non-ZIP64) ZIP and fit in memory (it is returned as one response). */
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 60_000;

export interface ExportRequest {
	/** Courses to export (ids), at least one. */
	courseIds: string[];
	/** Take the learner's progress along (review history, due dates, FSRS values). */
	progress: boolean;
	/** Topics become sub-decks. */
	subdecks: boolean;
}

export interface ExportResult {
	bytes: Buffer;
	filename: string;
	summary: ApkgExportSummary;
}

/** The request body from the wire → a clean request; throws StudyInputError (400). */
export function parseExportRequest(raw: unknown, knownCourseIds: readonly string[]): ExportRequest {
	const body = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const ids = Array.isArray(body.courseIds) ? body.courseIds : [];
	if (!ids.every((id): id is string => typeof id === "string")) throw new StudyInputError("courseIds must be a list of course ids", 400);
	const wanted = new Set(ids);
	// the store's order, not the request's: the same choice always gives the same package
	const courseIds = knownCourseIds.filter((id) => wanted.has(id));
	if (courseIds.length !== wanted.size) throw new StudyInputError("Unknown course in the selection", 404);
	if (courseIds.length === 0) throw new StudyInputError("Choose at least one course to export", 400);
	if (body.progress !== undefined && typeof body.progress !== "boolean") throw new StudyInputError("progress must be true or false", 400);
	if (body.subdecks !== undefined && typeof body.subdecks !== "boolean") throw new StudyInputError("subdecks must be true or false", 400);
	return { courseIds, progress: body.progress === true, subdecks: body.subdecks !== false };
}

// ─── SQLite ─────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null,
  dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null,
  dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null,
  tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null,
  usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null,
  reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null,
  flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null,
  lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

const FIELD_SEPARATOR = "\u001f";

/** The plan as a schema-11 collection file's bytes. */
export function writeCollection(plan: ApkgPlan, now: Date): Buffer {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learnbox-apkg-"));
	const file = path.join(dir, "collection.anki2");
	try {
		const db = new (sqlite().DatabaseSync)(file);
		try {
			db.exec(SCHEMA);
			const nowSeconds = Math.floor(now.getTime() / 1000);
			const json = collectionJson(plan, nowSeconds);
			db.prepare("INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, '{}')").run(plan.crt, now.getTime(), now.getTime(), json.conf, json.models, json.decks, json.dconf);
			db.exec("BEGIN");
			const note = db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, 0, 0, '')");
			for (const n of plan.notes) note.run(n.id, n.guid, n.mid, n.mod, n.tags.length > 0 ? ` ${n.tags.join(" ")} ` : "", n.fields.join(FIELD_SEPARATOR), n.fields[0] ?? "");
			const card = db.prepare("INSERT INTO cards VALUES (?, ?, ?, ?, ?, -1, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)");
			for (const c of plan.cards) card.run(c.id, c.nid, c.did, c.ord, c.mod, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, c.left, c.data);
			const log = db.prepare("INSERT INTO revlog VALUES (?, ?, -1, ?, ?, ?, ?, ?, ?)");
			for (const r of plan.revlog) log.run(r.id, r.cid, r.ease, r.ivl, r.lastIvl, r.factor, r.time, r.type);
			db.exec("COMMIT");
		} finally {
			db.close();
		}
		return fs.readFileSync(file);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ─── ZIP ────────────────────────────────────────────────────────────────────

export interface ZipEntry {
	name: string;
	data: Buffer;
	/** Try deflate (kept only when it makes the entry smaller); media files are already compressed, so they are stored. */
	deflate: boolean;
}

/** DOS date and time of a moment (local), as ZIP headers carry them. */
function dosStamp(d: Date): { time: number; date: number } {
	const year = Math.max(1980, d.getFullYear());
	return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

/** A minimal ZIP: one local header + data per entry, then the central directory. UTF-8 names, no ZIP64. */
export function zipEntries(entries: readonly ZipEntry[], now: Date): Buffer {
	if (entries.length > MAX_ENTRIES) throw new StudyInputError("That is too many files for one package", 400);
	const { time, date } = dosStamp(now);
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf-8");
		let method = 0;
		let body = entry.data;
		if (entry.deflate && entry.data.length > 0) {
			const packed = zlib.deflateRawSync(entry.data);
			if (packed.length < entry.data.length) {
				method = 8;
				body = packed;
			}
		}
		const crc = zlib.crc32(entry.data) >>> 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // UTF-8 names
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		const head = Buffer.alloc(46);
		head.writeUInt32LE(0x02014b50, 0);
		head.writeUInt16LE(20, 4); // version made by
		head.writeUInt16LE(20, 6); // version needed
		head.writeUInt16LE(0x0800, 8);
		head.writeUInt16LE(method, 10);
		head.writeUInt16LE(time, 12);
		head.writeUInt16LE(date, 14);
		head.writeUInt32LE(crc, 16);
		head.writeUInt32LE(body.length, 20);
		head.writeUInt32LE(entry.data.length, 24);
		head.writeUInt16LE(name.length, 28);
		head.writeUInt32LE(offset, 42);
		central.push(head, name);
		parts.push(local, name, body);
		offset += local.length + name.length + body.length;
		if (offset > MAX_PACKAGE_BYTES) throw new StudyInputError("That export is too large for one package (over 1 GB of cards and media)", 400);
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, directory, end]);
}

// ─── the package ────────────────────────────────────────────────────────────

/** A file of the media folder by a card's name: a bare file name only (no folders, no dot files). */
function readMedia(mediaDir: string, name: string): Buffer | null {
	if (name.length === 0 || name !== path.basename(name) || name.startsWith(".")) return null;
	try {
		const file = path.join(mediaDir, name);
		const stat = fs.statSync(file);
		return stat.isFile() && stat.size <= MAX_PACKAGE_BYTES ? fs.readFileSync(file) : null;
	} catch {
		return null;
	}
}

/** "Anatomie" → "Learnbox-Anatomie-2026-11-06.apkg": letters, digits, - and _ only. */
export function exportFileName(courseNames: readonly string[], now: Date): string {
	const label = courseNames.length === 1 ? courseNames[0]! : `${courseNames.length} courses`;
	const safe = label.normalize("NFC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "export";
	return `Learnbox-${safe}-${localDay(now)}.apkg`;
}

/** Plan, write, pack. Throws StudyInputError for a bad request. */
export function exportApkg(raw: unknown, now: Date = new Date(), deps: StudyDeps = defaultStudyDeps()): ExportResult {
	const courses = deps.store.readCourses();
	const request = parseExportRequest(raw, courses.map((c) => c.id));
	const chosen = courses.filter((c) => request.courseIds.includes(c.id));
	const plan = planApkg({
		courses: chosen,
		cards: deps.store.readCards(),
		reviews: deps.store.readReviews(),
		options: { progress: request.progress, subdecks: request.subdecks },
		now,
	});
	if (plan.cards.length === 0) throw new StudyInputError("The chosen courses have no cards to export", 400);

	const entries: ZipEntry[] = [{ name: "collection.anki2", data: writeCollection(plan, now), deflate: true }];
	const mediaMap: Record<string, string> = {};
	const missing: string[] = [];
	for (const name of plan.media) {
		const data = readMedia(deps.mediaDir, name);
		if (!data) {
			missing.push(name);
			continue;
		}
		const index = Object.keys(mediaMap).length;
		mediaMap[String(index)] = name;
		entries.push({ name: String(index), data, deflate: false });
	}
	entries.splice(1, 0, { name: "media", data: Buffer.from(JSON.stringify(mediaMap), "utf-8"), deflate: true });
	const bytes = zipEntries(entries, now);
	return {
		bytes,
		filename: exportFileName(chosen.map((c) => c.name), now),
		summary: { ...plan.summary, media: Object.keys(mediaMap).length, missingMedia: missing.slice(0, 20), missingCount: missing.length, bytes: bytes.length },
	};
}
