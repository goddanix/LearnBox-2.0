/**
 * AnkiSource — the fs/SQLite side of the Anki import (core/anki-import.ts)
 *
 * READ-ONLY toward Anki: the collection file (and its -wal/-shm siblings,
 * which hold recent writes) is COPIED to a temp dir and the copy is opened —
 * the original is never opened, locked or written, even while Anki runs
 * (the AnkiDeckWidget does the same). Uses node:sqlite, which Electron's own
 * Node ships, so no native dependency.
 *
 * Media: only the files the imported cards reference are copied, out of the
 * collection's media folder into our own (config.PATHS.studyMedia).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	AnkiCardRow,
	AnkiCollection,
	AnkiDeckRow,
	AnkiNoteRow,
	AnkiNoteTypeRow,
	AnkiRevlogRow,
} from "../core/anki-import.ts";
import { isClozeConfig } from "../core/anki-import.ts";

const SIDECARS = ["", "-wal", "-shm"] as const;

/** Read every table the import needs from a COPY of the collection at `dbPath`. */
export function readAnkiCollection(dbPath: string): AnkiCollection {
	if (!fs.existsSync(dbPath)) throw new Error(`Anki collection not found: ${dbPath}`);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "learnbox-anki-"));
	try {
		const copy = path.join(tmp, "collection.anki2");
		for (const suffix of SIDECARS) {
			const src = `${dbPath}${suffix}`;
			if (fs.existsSync(src)) fs.copyFileSync(src, `${copy}${suffix}`);
		}
		const db = new DatabaseSync(copy);
		try {
			const ver = (db.prepare("select ver from col").get() as { ver?: number } | undefined)?.ver;
			if (ver === undefined || ver < 18) {
				throw new Error(`Unsupported Anki collection schema ${ver ?? "?"} (need 18 or newer: Anki 2.1.50+)`);
			}
			const fieldNames = new Map<number, string[]>();
			for (const f of db.prepare("select ntid, name from fields order by ntid, ord").all() as {
				ntid: number;
				name: string;
			}[]) {
				const list = fieldNames.get(f.ntid) ?? [];
				list.push(f.name);
				fieldNames.set(f.ntid, list);
			}
			const noteTypes = (
				db.prepare("select id, name, config from notetypes").all() as {
					id: number;
					name: string;
					config: Uint8Array;
				}[]
			).map(
				(r): AnkiNoteTypeRow => ({
					id: r.id,
					name: r.name,
					isCloze: isClozeConfig(r.config),
					fields: fieldNames.get(r.id) ?? [],
				}),
			);
			return {
				decks: db.prepare("select id, name from decks").all() as unknown as AnkiDeckRow[],
				noteTypes,
				notes: db.prepare("select id, mid, tags, flds from notes").all() as unknown as AnkiNoteRow[],
				cards: db
					.prepare("select id, nid, did, ord, queue, odid from cards")
					.all() as unknown as AnkiCardRow[],
				revlog: db
					.prepare("select id, cid, ease, type, time from revlog order by id")
					.all() as unknown as AnkiRevlogRow[],
			};
		} finally {
			db.close();
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

export interface MediaCopyResult {
	copied: string[];
	/** Referenced by a card but absent from the media folder. */
	missing: string[];
	/** Already present in the destination (kept as is). */
	existing: string[];
}

/** Copy the named files from Anki's media folder into `destDir`; never overwrites. */
export function copyAnkiMedia(mediaDir: string, names: readonly string[], destDir: string): MediaCopyResult {
	const result: MediaCopyResult = { copied: [], missing: [], existing: [] };
	fs.mkdirSync(destDir, { recursive: true });
	for (const name of names) {
		// Names come from card fields: never let one leave the two folders.
		if (name !== path.basename(name)) {
			result.missing.push(name);
			continue;
		}
		const src = path.join(mediaDir, name);
		const dest = path.join(destDir, name);
		if (!fs.existsSync(src)) result.missing.push(name);
		else if (fs.existsSync(dest)) result.existing.push(name);
		else {
			fs.copyFileSync(src, dest);
			result.copied.push(name);
		}
	}
	return result;
}
