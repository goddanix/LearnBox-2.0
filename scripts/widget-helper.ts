/**
 * Learnbox 2.0 widget helper — computes the numbers the macOS widget shows.
 *
 *   widget-helper [--data-dir <dir>] [--out <file>] [--now <iso-time>]
 *
 * Defaults: the desktop app's data folder (~/Library/Application Support/Learnbox/data) in, the widget's snapshot
 * (~/Library/Application Support/Learnbox/widget/widget.json) out. It reads the study ledgers and changes nothing
 * but the snapshot file. Prints one JSON line (`{"ok":true,"changed":…,"courses":…,"due":…,"new":…}`), exit 0; on
 * failure `{"ok":false,"error":…}` on stderr, exit 1 (2 for a usage error).
 *
 * Run from the repo with `npx tsx scripts/widget-helper.ts`; shipped as one self-contained file
 * (scripts/build-widget.mjs → widget-helper.mjs), which the widget's companion app runs with the desktop app's own
 * Electron binary as Node (ELECTRON_RUN_AS_NODE=1) — no Node install needed on the Mac.
 */

import * as os from "node:os";
import { HelperUsageError, parseHelperArgs, runHelper } from "../src/server/widget-file.ts";

try {
	const result = runHelper(parseHelperArgs(process.argv.slice(2), os.homedir()));
	process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (e) {
	process.stderr.write(`${JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })}\n`);
	process.exit(e instanceof HelperUsageError ? 2 : 1);
}
