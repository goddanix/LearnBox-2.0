/**
 * The one-shot Claude call (src/agent/claude-ask.ts) against a FAKE `claude`
 * executable that records how it was called — zero network, zero real CLI.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { ClaudeAskError, askClaude, parseAskResult } from "../src/agent/claude-ask.ts";
import { resetClaudeCliCache } from "../src/agent/claude-cli.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lb-claude-ask-"));
const log = path.join(tmp, "calls.jsonl");
const fake = path.join(tmp, "claude");
const cwd = path.join(tmp, "work");

/** Records args, stdin, cwd and chosen env, then answers from FAKE_CLI_* env. */
const FAKE_SOURCE = `#!/usr/bin/env node
const fs = require("fs");
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
	fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ args: process.argv.slice(2), stdin, cwd: process.cwd(), env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null, CLAUDE_CODE_DISABLE_CLAUDE_MDS: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS ?? null } }) + "\\n");
	if (process.env.FAKE_CLI_SLEEP) { setTimeout(() => process.exit(0), Number(process.env.FAKE_CLI_SLEEP)); return; }
	if (process.env.FAKE_CLI_STDERR) process.stderr.write(process.env.FAKE_CLI_STDERR);
	if (process.env.FAKE_CLI_STDOUT !== undefined) process.stdout.write(process.env.FAKE_CLI_STDOUT);
	process.exit(Number(process.env.FAKE_CLI_EXIT ?? 0));
});
`;

const envelope = (result: string, extra: object = {}) => JSON.stringify({ type: "result", is_error: false, result, total_cost_usd: 0.0123, duration_ms: 4200, ...extra });

before(() => {
	fs.mkdirSync(cwd);
	fs.writeFileSync(fake, FAKE_SOURCE, { mode: 0o755 });
	process.env.FAKE_CLI_LOG = log;
});
after(() => {
	for (const key of ["LEARNBOX_CLAUDE_BIN", "FAKE_CLI_LOG", "FAKE_CLI_STDOUT", "FAKE_CLI_STDERR", "FAKE_CLI_EXIT", "FAKE_CLI_SLEEP", "ANTHROPIC_API_KEY"]) delete process.env[key];
	resetClaudeCliCache();
	fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
	process.env.LEARNBOX_CLAUDE_BIN = fake;
	for (const key of ["FAKE_CLI_STDOUT", "FAKE_CLI_STDERR", "FAKE_CLI_EXIT", "FAKE_CLI_SLEEP"]) delete process.env[key];
	fs.rmSync(log, { force: true });
	resetClaudeCliCache();
});

const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; stdin: string; cwd: string; env: Record<string, string | null> }) : []);
const request = (over: object = {}) => ({ prompt: "Page 3 prompt", system: "You write questions.", cwd, model: "sonnet", ...over });

describe("parseAskResult", () => {
	it("reads the text, the cost and the duration from the CLI's envelope", () => {
		assert.deepEqual(parseAskResult(envelope('{"questions": []}')), { text: '{"questions": []}', costUsd: 0.0123, durationMs: 4200 });
	});

	it("takes plain output that is not an envelope as the answer", () => {
		assert.deepEqual(parseAskResult("just text\n"), { text: "just text", costUsd: 0, durationMs: 0 });
	});

	it("names a lost sign-in", () => {
		assert.throws(() => parseAskResult("Not logged in · Please run /login"), (e) => e instanceof ClaudeAskError && e.kind === "auth" && /not signed in/.test(e.message));
	});

	it("tells an auth failure, a reached limit and any other error apart", () => {
		const fail = (result: string, status?: number) => envelope(result, { is_error: true, ...(status ? { api_error_status: status } : {}) });
		assert.throws(() => parseAskResult(fail("denied", 401)), (e) => e instanceof ClaudeAskError && e.kind === "auth");
		assert.throws(() => parseAskResult(fail("slow down", 429)), (e) => e instanceof ClaudeAskError && e.kind === "limit" && /usage limit/.test(e.message));
		assert.throws(() => parseAskResult(fail("Claude usage limit reached")), (e) => e instanceof ClaudeAskError && e.kind === "limit");
		assert.throws(() => parseAskResult(fail("something broke")), (e) => e instanceof ClaudeAskError && e.kind === "other" && /something broke/.test(e.message));
	});
});

describe("askClaude", () => {
	it("sends the prompt on stdin and runs isolated, with the Read tool, in the job folder", async () => {
		process.env.FAKE_CLI_STDOUT = envelope("hello");
		const answer = await askClaude(request());
		assert.deepEqual(answer, { text: "hello", costUsd: 0.0123, durationMs: 4200 });

		const [call] = calls();
		assert.ok(call);
		assert.equal(call.stdin, "Page 3 prompt");
		assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(cwd));
		const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
		assert.ok(call.args.includes("-p"));
		assert.equal(flag("--output-format"), "json");
		assert.equal(flag("--model"), "sonnet");
		assert.equal(flag("--system-prompt"), "You write questions.");
		assert.equal(flag("--tools"), "Read");
		assert.equal(flag("--allowedTools"), "Read");
		assert.equal(flag("--setting-sources"), "");
		for (const isolating of ["--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"]) {
			assert.ok(call.args.includes(isolating), isolating);
		}
		assert.equal(call.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
	});

	it("never lets an API key move the call onto per-token billing", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
		process.env.FAKE_CLI_STDOUT = envelope("ok");
		await askClaude(request());
		assert.equal(calls()[0]!.env.ANTHROPIC_API_KEY, null);
	});

	it("reports a missing CLI", async () => {
		process.env.LEARNBOX_CLAUDE_BIN = path.join(tmp, "does-not-exist");
		await assert.rejects(askClaude(request()), (e) => e instanceof ClaudeAskError && e.kind === "missing" && /not found/.test(e.message));
	});

	it("reports a lost sign-in from the CLI's output", async () => {
		process.env.FAKE_CLI_STDOUT = "Not logged in · Please run /login";
		await assert.rejects(askClaude(request()), (e) => e instanceof ClaudeAskError && e.kind === "auth");
	});

	it("falls back to stderr, then to the exit code, when there is no output", async () => {
		process.env.FAKE_CLI_STDERR = "boom on stderr";
		process.env.FAKE_CLI_EXIT = "2";
		await assert.rejects(askClaude(request()), (e) => e instanceof ClaudeAskError && e.kind === "other" && /boom on stderr/.test(e.message));
		delete process.env.FAKE_CLI_STDERR;
		await assert.rejects(askClaude(request()), (e) => e instanceof ClaudeAskError && /code 2/.test(e.message));
	});

	it("stops on an abort signal, before and during the call", async () => {
		const early = new AbortController();
		early.abort();
		await assert.rejects(askClaude(request({ signal: early.signal })), (e) => e instanceof ClaudeAskError && e.kind === "aborted");

		process.env.FAKE_CLI_SLEEP = "5000";
		const late = new AbortController();
		const pending = askClaude(request({ signal: late.signal }));
		setTimeout(() => late.abort(), 150);
		await assert.rejects(pending, (e) => e instanceof ClaudeAskError && e.kind === "aborted");
	});

	it("gives up after the timeout", async () => {
		process.env.FAKE_CLI_SLEEP = "5000";
		await assert.rejects(askClaude(request({ timeoutMs: 200 })), (e) => e instanceof ClaudeAskError && e.kind === "other" && /did not answer/.test(e.message));
	});
});
