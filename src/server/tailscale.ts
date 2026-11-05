/**
 * Tailscale, as far as phone access needs it (Learnbox 2.0, Slice 10): read its status, and — only when the learner
 * clicks the button in Settings → Phone — tell Tailscale Serve to forward the tailnet's https to the gateway.
 *
 * Nothing here runs on its own: `status` and `serving` only read; `serve` and `stopServing` change Tailscale's
 * configuration and are called from the Settings buttons alone. The CLI is spawned without a shell, with a timeout and
 * no stdin (Serve asks questions on a terminal when HTTPS is not switched on; here that must fail, not wait).
 * `exec` and the binary are seams so tests never touch the real Tailscale.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { parseTailscaleStatus, serveForwardsTo } from "../core/mobile.ts";
import type { TailscaleState } from "../core/contracts.ts";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}
export type Exec = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

export class TailscaleError extends Error {}

export interface TailscaleRunner {
	/** `tailscale status --json`, read into a state; "not-installed" when there is no CLI to ask. */
	status(): Promise<TailscaleState>;
	/** Does Tailscale Serve forward https to http://127.0.0.1:<port> already? (read-only) */
	serving(port: number): Promise<boolean>;
	/** `tailscale serve --bg --https=443 http://127.0.0.1:<port>` — changes Tailscale's configuration. */
	serve(port: number): Promise<void>;
	/** `tailscale serve --https=443 off` — takes our forwarding down again. */
	stopServing(): Promise<void>;
}

const CANDIDATES = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

const realExec: Exec = (file, args, timeoutMs) =>
	new Promise((resolve) => {
		const child = execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 1_048_576, env: process.env }, (error, stdout, stderr) => {
			const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr) });
		});
		child.stdin?.end();
	});

/** Where the CLI lives: the first candidate that exists and is executable. */
export function findTailscale(exists: (p: string) => boolean = isExecutable): string | null {
	return CANDIDATES.find(exists) ?? null;
}

function isExecutable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The part of a failed command worth showing: its last non-empty lines, trimmed. */
function reason(result: ExecResult): string {
	const text = `${result.stderr}\n${result.stdout}`.trim().split("\n").map((l) => l.trim()).filter(Boolean);
	return text.slice(-3).join(" ") || `exit code ${result.code}`;
}

export function createTailscaleRunner(options: { bin?: string | null; exec?: Exec; timeoutMs?: number } = {}): TailscaleRunner {
	const exec = options.exec ?? realExec;
	const timeoutMs = options.timeoutMs ?? 15_000;
	const bin = () => (options.bin !== undefined ? options.bin : findTailscale());

	const run = async (args: readonly string[], ms = timeoutMs): Promise<ExecResult> => {
		const file = bin();
		if (!file) throw new TailscaleError("Tailscale is not installed on this Mac.");
		return exec(file, args, ms);
	};

	return {
		async status() {
			if (!bin()) return { state: "not-installed", httpsReady: false };
			const result = await run(["status", "--json"], 5_000);
			try {
				return parseTailscaleStatus(JSON.parse(result.stdout));
			} catch {
				// no JSON: the background service is not running (or not answering)
				return { state: /failed to connect|not running|stopped/i.test(`${result.stderr}${result.stdout}`) ? "stopped" : "unknown", httpsReady: false };
			}
		},
		async serving(port) {
			if (!bin()) return false;
			const result = await run(["serve", "status", "--json"], 5_000);
			try {
				return serveForwardsTo(JSON.parse(result.stdout), port);
			} catch {
				return false;
			}
		},
		async serve(port) {
			const result = await run(["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
			if (result.code !== 0) throw new TailscaleError(`Tailscale could not share the phone gateway: ${reason(result)}`);
		},
		async stopServing() {
			const result = await run(["serve", "--https=443", "off"]);
			if (result.code !== 0) throw new TailscaleError(`Tailscale could not stop sharing: ${reason(result)}`);
		},
	};
}
