/**
 * Start the Anki cards over: remove what an earlier Anki import put into the study ledgers and import the collection
 * again — first sub-deck = course, the levels below = topic.
 *
 *   anki-reset-import --data-dir <dir> --collection <file.anki2>
 *                     [--subject-level 1] [--skip "<deck>"]… [--merge "<deck prefix>=<Course>"]…
 *                     [--backup-dir <dir>] [--apply]
 *
 * Without --apply it only looks: prints the new structure and what the reset would remove or lose, and changes nothing.
 * With --apply it refuses while the desktop app is running on the data folder, copies the three ledgers into the backup
 * folder (default: beside the data folder), rewrites them without the Anki cards and imports again. Study media and
 * cards of any other origin stay. The Anki collection is read from a copy and never changed.
 *
 * Exit 0; a usage error exits 2, any other failure 1 (message on stderr).
 */

import { formatReport, parseResetArgs, ResetUsageError, runResetImport } from "../src/server/anki-reset.ts";

try {
	process.stdout.write(`${formatReport(runResetImport(parseResetArgs(process.argv.slice(2))))}\n`);
} catch (e) {
	process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(e instanceof ResetUsageError ? 2 : 1);
}
