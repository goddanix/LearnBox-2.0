import { spawn } from "node:child_process";
import * as path from "node:path";
import { API_BILLING_ENV, claudeCliErrorText, resolveClaudeBinary } from "./claude-cli.ts";

/**
 * One-shot Claude calls for the Create jobs (Learnbox 2.0, 2026-11): a page
 * image and a prompt go in, the model's text comes out. This is MedAnki's
 * `ask_claude` (medanki/llm.py) on the learner's own Claude CLI sign-in, the
 * same account and isolation rules as the chat provider (claude-cli.ts) — but
 * a different shape: the model may open the page image with the Read tool
 * (inside `cwd` only), and the answer is free text the caller parses.
 *
 * No key is read or used: API-billing variables are stripped from the child's
 * environment, so a stray ANTHROPIC_API_KEY cannot move the call onto a
 * per-token bill. The call is isolated from the learner's Claude Code setup
 * (no settings, hooks, skills or MCP servers, no CLAUDE.md memory files).
 */

export type ClaudeAskErrorKind = "missing" | "auth" | "limit" | "aborted" | "other";

/** A failed call. `message` is learner-facing wording; `kind` tells the caller whether a retry can help:
 *  only "other" is worth another try — a missing CLI, a lost sign-in or a reached plan limit stops the run. */
export class ClaudeAskError extends Error {
	constructor(
		message: string,
		readonly kind: ClaudeAskErrorKind = "other",
	) {
		super(message);
		this.name = "ClaudeAskError";
	}
}

export interface AskClaudeRequest {
	prompt: string;
	system: string;
	/** Working folder of the call: the Read tool may open files in it (the page image). */
	cwd: string;
	/** `--model` value: an alias ("sonnet", "haiku") or a full model id. */
	model: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface AskClaudeResult {
	text: string;
	costUsd: number;
	durationMs: number;
}

/** The seam the Create jobs call; tests replace it with a scripted answer. */
export type AskClaude = (request: AskClaudeRequest) => Promise<AskClaudeResult>;

const DEFAULT_TIMEOUT_MS = 7 * 60_000;

/** The CLI's JSON result → our result. Exported for tests. */
export function parseAskResult(stdout: string): AskClaudeResult {
	const out = stdout.trim();
	if (/Not logged in|Please run \/login/.test(out)) throw new ClaudeAskError(claudeCliErrorText(out, "auth"), "auth");
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(out) as Record<string, unknown>;
	} catch {
		// Not the JSON envelope: the plain text is the answer.
		return { text: out, costUsd: 0, durationMs: 0 };
	}
	if (data.is_error === true) {
		const message = typeof data.result === "string" ? data.result : "the CLI reported an error";
		const status = data.api_error_status;
		const kind: ClaudeAskErrorKind = status === 401 || status === 403 ? "auth" : status === 429 || status === 529 ? "limit" : "other";
		const wording = claudeCliErrorText(message, kind);
		// claudeCliErrorText also recognises auth/limit by the message text.
		const refined: ClaudeAskErrorKind = /not signed in/.test(wording) ? "auth" : /usage limit/.test(wording) ? "limit" : kind;
		throw new ClaudeAskError(wording, refined);
	}
	return {
		text: typeof data.result === "string" ? data.result : "",
		costUsd: typeof data.total_cost_usd === "number" ? data.total_cost_usd : 0,
		durationMs: typeof data.duration_ms === "number" ? data.duration_ms : 0,
	};
}

export const askClaude: AskClaude = async (request) => {
	const binary = resolveClaudeBinary();
	if (!binary) throw new ClaudeAskError(claudeCliErrorText("claude binary not found", "missing"), "missing");
	if (request.signal?.aborted) throw new ClaudeAskError(claudeCliErrorText("cancelled", "aborted"), "aborted");

	const args = [
		"-p",
		"--output-format", "json",
		"--model", request.model,
		"--system-prompt", request.system,
		"--no-session-persistence",
		"--setting-sources", "",
		"--strict-mcp-config",
		"--disable-slash-commands",
		"--tools", "Read",
		"--allowedTools", "Read",
	];
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: [path.dirname(binary), process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(path.delimiter),
		CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
	};
	for (const name of API_BILLING_ENV) delete env[name];

	return await new Promise<AskClaudeResult>((resolve, reject) => {
		const child = spawn(binary, args, { cwd: request.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		let settled = false;
		const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const onAbort = () => {
			child.kill("SIGTERM");
			finish(() => reject(new ClaudeAskError(claudeCliErrorText("cancelled", "aborted"), "aborted")));
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(() => reject(new ClaudeAskError(`The Claude CLI did not answer within ${Math.round(timeoutMs / 60_000)} minutes.`)));
		}, timeoutMs);
		request.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", (e) =>
			finish(() => {
				const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
				reject(new ClaudeAskError(missing ? claudeCliErrorText("claude binary not found", "missing") : e.message, missing ? "missing" : "other"));
			}),
		);
		child.on("close", (code) =>
			finish(() => {
				if (out.trim()) {
					try {
						resolve(parseAskResult(out));
					} catch (e) {
						reject(e);
					}
					return;
				}
				reject(new ClaudeAskError(err.trim().slice(0, 500) || `The Claude CLI exited with code ${code} and no output.`));
			}),
		);
		child.stdin.on("error", () => {});
		child.stdin.end(request.prompt);
	});
};
