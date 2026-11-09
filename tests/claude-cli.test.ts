/**
 * Claude CLI provider tests — deterministic, zero network, zero real CLI:
 *
 *   1. pure pieces: the answer schema, the request (system, transcript,
 *      images), the effort mapping, the CLI result parser, the error wording
 *   2. the model list: catalog entries under the claude-cli provider, free
 *   3. the stream, against a FAKE `claude` executable that records how it was
 *      called: events, usage, the flags that isolate the call, the stripped
 *      billing environment, failure and abort paths
 *   4. the seams: engine wiring, key presence, the picker's catalog, settings
 *      validation
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import type { AssistantMessage, AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
	CLAUDE_CLI_MODEL_IDS,
	CLAUDE_CLI_PROVIDER,
	answerSchema,
	buildRequest,
	claudeCliAvailable,
	claudeCliErrorText,
	claudeCliModel,
	claudeCliModels,
	claudeCliStream,
	cliEffort,
	closeClaudeCliProcesses,
	parseCliResult,
	resolveClaudeBinary,
	structuredTextSoFar,
	warmClaudeCliProcessCount,
} from "../src/agent/claude-cli.ts";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lb-claude-cli-"));
const log = path.join(tmp, "calls.jsonl");
const fake = path.join(tmp, "claude");

/** A fake `claude`: records args, stdin and chosen env, then answers from FAKE_CLI_* env. */
const FAKE_SOURCE = `#!/usr/bin/env node
const fs = require("fs");
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
	fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ args: process.argv.slice(2), stdin, cwd: process.cwd(), env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null, HOME: process.env.HOME ?? null } }) + "\\n");
	if (process.env.FAKE_CLI_SLEEP) { setTimeout(() => process.exit(0), Number(process.env.FAKE_CLI_SLEEP)); return; }
	if (process.env.FAKE_CLI_STDERR) process.stderr.write(process.env.FAKE_CLI_STDERR);
	if (process.env.FAKE_CLI_STDOUT !== undefined) process.stdout.write(process.env.FAKE_CLI_STDOUT);
	process.exit(Number(process.env.FAKE_CLI_EXIT ?? 0));
});
`;

const USAGE = { input_tokens: 5, cache_creation_input_tokens: 1200, cache_read_input_tokens: 300, output_tokens: 90, output_tokens_details: { thinking_tokens: 40 } };
const ok = (answer: unknown, extra: object = {}) => JSON.stringify({ type: "result", is_error: false, stop_reason: "tool_use", usage: USAGE, structured_output: answer, result: JSON.stringify(answer), ...extra });

before(() => {
	fs.writeFileSync(fake, FAKE_SOURCE, { mode: 0o755 });
	process.env.FAKE_CLI_LOG = log;
	// The cold, one-shot path (the fake above speaks it); the warm path has its own describe below.
	process.env.LEARNBOX_CLAUDE_PERSISTENT = "0";
});
after(() => {
	for (const key of ["LEARNBOX_CLAUDE_PERSISTENT", "LEARNBOX_CLAUDE_BIN", "FAKE_CLI_LOG", "FAKE_CLI_STDOUT", "FAKE_CLI_STDERR", "FAKE_CLI_EXIT", "FAKE_CLI_SLEEP", "ANTHROPIC_API_KEY"]) delete process.env[key];
	fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
	process.env.LEARNBOX_CLAUDE_BIN = fake;
	for (const key of ["FAKE_CLI_STDOUT", "FAKE_CLI_STDERR", "FAKE_CLI_EXIT", "FAKE_CLI_SLEEP"]) delete process.env[key];
	fs.rmSync(log, { force: true });
});

const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; stdin: string; cwd: string; env: Record<string, string | null> }) : []);

/** The shape providers really receive: prompt and tools folded into leading system messages. */
const norm = (context: Context) => normalizeContext(context);

const probe = { name: "probe", description: "Ask the learner a question.", parameters: Type.Object({ question: Type.String() }) };
const ctx = (over: Partial<Context> = {}): Context => ({
	systemPrompt: "You are the teacher.",
	messages: [{ role: "user", content: "Teach me the Nernst equation.", timestamp: 1 }],
	tools: [probe],
	...over,
});

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const e of stream) events.push(e);
	return events;
}
const model = () => claudeCliModel(piModels(), "claude-sonnet-5-5")!;
const run = (context: Context, options: object = {}) => collect(claudeCliStream()(model(), norm(context), options as never));
const last = (events: AssistantMessageEvent[]) => events[events.length - 1]!;

describe("the request", () => {
	it("limits the structured answer to the tools on offer", () => {
		const schema = answerSchema(["probe", "quiz"]) as { properties: { tool_calls: { items: { properties: { name: { enum: string[] } } } } }; required: string[] };
		assert.deepEqual(schema.properties.tool_calls.items.properties.name.enum, ["probe", "quiz"]);
		assert.deepEqual(schema.required, ["text", "tool_calls"]);
		const bare = answerSchema([]) as { properties: object; required: string[] };
		assert.deepEqual(Object.keys(bare.properties), ["text"]);
	});

	it("keeps the app's system prompt and adds the answer protocol and the tool list", () => {
		const { system } = buildRequest(norm(ctx()));
		assert.ok(system.startsWith("You are the teacher."));
		assert.match(system, /Answer ONLY through the structured output/);
		assert.match(system, /"name":"probe"/);
		assert.match(system, /Ask the learner a question\./);
		assert.doesNotMatch(buildRequest(norm(ctx({ tools: [] }))).system, /## Tools/);
	});

	it("writes the conversation as a transcript: calls, results, errors; thinking is not replayed", () => {
		const messages: Context["messages"] = [
			{ role: "user", content: "Hello", timestamp: 1 },
			{
				role: "assistant", api: "anthropic-messages", provider: CLAUDE_CLI_PROVIDER, model: "m", stopReason: "toolUse", timestamp: 2,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				content: [
					{ type: "thinking", thinking: "SECRET REASONING" },
					{ type: "text", text: "Let me ask." },
					{ type: "toolCall", id: "call_1", name: "probe", arguments: { question: "Why?" } },
				],
			},
			{ role: "toolResult", toolCallId: "call_1", toolName: "probe", content: [{ type: "text", text: "Because." }], isError: false, timestamp: 3 },
			{ role: "toolResult", toolCallId: "call_2", toolName: "quiz", content: [{ type: "text", text: "bad input" }], isError: true, timestamp: 4 },
		];
		const { prompt } = buildRequest(norm(ctx({ messages })));
		assert.match(prompt, /\[user\]\nHello/);
		assert.match(prompt, /\[assistant\]\nLet me ask\./);
		assert.match(prompt, /\[tool_call id=call_1 name=probe\]\n\{"question":"Why\?"\}/);
		assert.match(prompt, /\[tool_result id=call_1 name=probe\]\nBecause\./);
		assert.match(prompt, /\[tool_result id=call_2 name=quiz error=true\]\nbad input/);
		assert.doesNotMatch(prompt, /SECRET REASONING/);
		assert.match(prompt, /^<transcript>/);
		assert.match(prompt, /Continue as the assistant/);
	});

	it("turns images into files the CLI can read, and says so", () => {
		const png = Buffer.from("not really a png").toString("base64");
		const request = buildRequest(norm(ctx({ messages: [{ role: "user", content: [{ type: "text", text: "Look:" }, { type: "image", data: png, mimeType: "image/png" }], timestamp: 1 }] })));
		assert.ok(request.imageDir);
		const file = /\[image attached: (.+?)\]/.exec(request.prompt)?.[1];
		assert.ok(file && fs.existsSync(file));
		assert.equal(fs.readFileSync(file, "utf8"), "not really a png");
		assert.match(request.system, /open each with the Read tool/);
		fs.rmSync(request.imageDir!, { recursive: true, force: true });
		assert.equal(buildRequest(norm(ctx())).imageDir, null, "no images, no directory");
	});

	it("maps thinking levels to the CLI's effort scale", () => {
		assert.equal(cliEffort(undefined), undefined);
		assert.equal(cliEffort("off"), undefined);
		assert.equal(cliEffort("minimal"), "low");
		for (const level of ["low", "medium", "high", "xhigh", "max"]) assert.equal(cliEffort(level), level);
	});
});

describe("the CLI result", () => {
	it("reads the structured answer, the tool calls and the token usage", () => {
		const answer = parseCliResult(ok({ text: "Okay.", tool_calls: [{ name: "probe", arguments: { question: "Why?" } }, { name: 7 }] }));
		assert.equal(answer.text, "Okay.");
		assert.deepEqual(answer.toolCalls, [{ name: "probe", arguments: { question: "Why?" } }], "a call without a name is dropped");
		assert.equal(answer.stopReason, "toolUse");
		assert.deepEqual([answer.usage.input, answer.usage.output, answer.usage.cacheRead, answer.usage.cacheWrite, answer.usage.totalTokens, answer.usage.reasoning], [5, 90, 300, 1200, 1595, 40]);
		assert.equal(answer.usage.cost.total, 0, "the plan pays, there is no per-token cost");
	});

	it("stops with 'stop' when there are no tool calls and 'length' on max_tokens", () => {
		assert.equal(parseCliResult(ok({ text: "Done.", tool_calls: [] }, { stop_reason: "end_turn" })).stopReason, "stop");
		assert.equal(parseCliResult(ok({ text: "Cut off", tool_calls: [] }, { stop_reason: "max_tokens" })).stopReason, "length");
	});

	it("falls back to JSON in `result`, and to plain prose as the answer's text", () => {
		const viaResult = parseCliResult(JSON.stringify({ is_error: false, result: JSON.stringify({ text: "T", tool_calls: [{ name: "probe", arguments: {} }] }) }));
		assert.equal(viaResult.toolCalls.length, 1);
		const prose = parseCliResult(JSON.stringify({ is_error: false, result: "Just words." }));
		assert.deepEqual([prose.text, prose.toolCalls.length], ["Just words.", 0]);
	});

	it("refuses unreadable output and CLI errors, classifying sign-in and limit problems", () => {
		assert.throws(() => parseCliResult("not json"), /unreadable CLI output/);
		assert.throws(() => parseCliResult(JSON.stringify({ is_error: true, result: "Not logged in · Please run /login", api_error_status: 401 })), (e: Error & { kind: string }) => e.kind === "auth");
		assert.throws(() => parseCliResult(JSON.stringify({ is_error: true, result: "limit", api_error_status: 429 })), (e: Error & { kind: string }) => e.kind === "limit");
		assert.throws(() => parseCliResult(JSON.stringify({ is_error: true, result: "boom" })), (e: Error & { kind: string }) => e.kind === "other");
	});

	it("words failures for the learner, never with a stack trace, and always says no key is used", () => {
		assert.match(claudeCliErrorText("x", "missing"), /not found.*No API key is used/);
		assert.match(claudeCliErrorText("Not logged in · Please run /login", "other"), /not signed in/);
		assert.match(claudeCliErrorText("usage limit reached", "other"), /usage limit.*No API key/);
		assert.match(claudeCliErrorText("x", "aborted"), /cancelled/);
		assert.match(claudeCliErrorText("odd failure", "other"), /^Claude CLI error: odd failure/);
	});
});

describe("the models", () => {
	it("lists the Claude models under the claude-cli provider, free of per-token cost", () => {
		const models = claudeCliModels(piModels());
		assert.deepEqual(models.map((m) => m.id), [...CLAUDE_CLI_MODEL_IDS]);
		for (const m of models) {
			assert.equal(m.provider, CLAUDE_CLI_PROVIDER);
			assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			assert.match(m.name, /\(Claude CLI\)$/);
			assert.ok(m.input.includes("image"));
		}
		assert.equal(claudeCliModel(piModels(), "gpt-5"), undefined);
		assert.equal(claudeCliModel(piModels(), "claude-sonnet-4-5"), undefined, "only the models the CLI list carries");
	});

	it("finds the binary by the explicit override, and only by it", () => {
		assert.equal(resolveClaudeBinary(), fake);
		assert.equal(claudeCliAvailable(), true);
		process.env.LEARNBOX_CLAUDE_BIN = path.join(tmp, "nothing-here");
		assert.equal(resolveClaudeBinary(), null, "no quiet fallback to another claude on the machine");
		assert.equal(claudeCliAvailable(), false);
	});
});

describe("the stream", () => {
	it("replays the answer as events: text, then each tool call, then done with usage", async () => {
		process.env.FAKE_CLI_STDOUT = ok({ text: "Let me ask.", tool_calls: [{ name: "probe", arguments: { question: "Why?" } }, { name: "probe", arguments: { question: "How?" } }] });
		const events = await run(ctx());
		assert.deepEqual(events.map((e) => e.type), ["start", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
		const done = last(events) as Extract<AssistantMessageEvent, { type: "done" }>;
		assert.equal(done.reason, "toolUse");
		assert.equal(done.message.provider, CLAUDE_CLI_PROVIDER);
		assert.deepEqual(done.message.content.map((b) => b.type), ["text", "toolCall", "toolCall"]);
		const [a, b] = done.message.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall");
		assert.deepEqual([a!.name, a!.arguments], ["probe", { question: "Why?" }]);
		assert.notEqual(a!.id, b!.id, "every call gets its own id");
		assert.equal(done.message.usage.output, 90);
	});

	it("an answer without tool calls ends with 'stop'; an empty text adds no text block", async () => {
		process.env.FAKE_CLI_STDOUT = ok({ text: "", tool_calls: [] }, { stop_reason: "end_turn" });
		const events = await run(ctx());
		assert.deepEqual(events.map((e) => e.type), ["start", "done"]);
		assert.equal((last(events) as { reason: string }).reason, "stop");
	});

	it("calls the CLI isolated from the learner's Claude setup, with the transcript on stdin", async () => {
		process.env.FAKE_CLI_STDOUT = ok({ text: "x", tool_calls: [] });
		await run(ctx(), { reasoning: "high" });
		const [call] = calls();
		const args = call!.args;
		const after = (flag: string) => args[args.indexOf(flag) + 1];
		assert.ok(args.includes("-p"));
		assert.equal(after("--output-format"), "json");
		assert.equal(after("--model"), "claude-sonnet-5-5");
		assert.equal(after("--setting-sources"), "", "no user or project settings, hooks or CLAUDE.md");
		assert.ok(args.includes("--strict-mcp-config") && args.includes("--disable-slash-commands") && args.includes("--no-session-persistence"));
		assert.equal(after("--tools"), "", "the CLI's own tools are off");
		assert.equal(after("--effort"), "high");
		assert.match(after("--system-prompt") ?? "", /^You are the teacher\./);
		assert.deepEqual(JSON.parse(after("--json-schema") ?? "{}").required, ["text", "tool_calls"]);
		assert.match(call!.stdin, /\[user\]\nTeach me the Nernst equation\./);
		assert.ok(call!.cwd.includes("learnbox-cli-"), "runs in an empty scratch directory");
		assert.ok(!fs.existsSync(call!.cwd), "which is removed afterwards");
	});

	it("never lets an API key reach the CLI, so it cannot bill per token", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-be-passed";
		process.env.FAKE_CLI_STDOUT = ok({ text: "x", tool_calls: [] });
		await run(ctx());
		assert.equal(calls()[0]!.env.ANTHROPIC_API_KEY, null);
		delete process.env.ANTHROPIC_API_KEY;
	});

	it("opens the Read tool only for the image directory, and only when there are images", async () => {
		process.env.FAKE_CLI_STDOUT = ok({ text: "x", tool_calls: [] });
		await run(ctx({ messages: [{ role: "user", content: [{ type: "image", data: Buffer.from("x").toString("base64"), mimeType: "image/png" }], timestamp: 1 }] }));
		const args = calls()[0]!.args;
		assert.equal(args[args.indexOf("--tools") + 1], "Read");
		assert.equal(args[args.indexOf("--allowedTools") + 1], "Read");
		assert.match(args[args.indexOf("--add-dir") + 1] ?? "", /learnbox-images-/);
	});

	it("moves a huge system prompt to stdin instead of argv", async () => {
		process.env.FAKE_CLI_STDOUT = ok({ text: "x", tool_calls: [] });
		await run(ctx({ systemPrompt: "S".repeat(300_000) }));
		const call = calls()[0]!;
		assert.ok(call.args[call.args.indexOf("--system-prompt") + 1]!.length < 200);
		assert.ok(call.stdin.startsWith("<system>\nSSSS"));
	});

	it("reports a CLI that is not installed, in plain words", async () => {
		process.env.LEARNBOX_CLAUDE_BIN = path.join(tmp, "nothing-here");
		const events = await run(ctx());
		const error = last(events) as Extract<AssistantMessageEvent, { type: "error" }>;
		assert.equal(error.type, "error");
		assert.match(error.error.errorMessage ?? "", /Claude CLI was not found.*No API key is used/);
	});

	it("reports a signed-out CLI, a plan limit, and a crash with no output", async () => {
		const message = async () => ((last(await run(ctx())) as Extract<AssistantMessageEvent, { type: "error" }>).error as AssistantMessage).errorMessage ?? "";
		process.env.FAKE_CLI_STDOUT = JSON.stringify({ is_error: true, result: "Not logged in · Please run /login", api_error_status: 401 });
		assert.match(await message(), /not signed in/);
		process.env.FAKE_CLI_STDOUT = JSON.stringify({ is_error: true, result: "Claude AI usage limit reached", api_error_status: 429 });
		assert.match(await message(), /usage limit/);
		process.env.FAKE_CLI_STDOUT = "";
		process.env.FAKE_CLI_STDERR = "segfault, sorry";
		process.env.FAKE_CLI_EXIT = "3";
		assert.match(await message(), /Claude CLI error: segfault, sorry/);
	});

	it("aborts: the child is killed and the stream ends 'aborted'", async () => {
		process.env.FAKE_CLI_SLEEP = "30000";
		const controller = new AbortController();
		const started = Date.now();
		const pending = run(ctx(), { signal: controller.signal });
		setTimeout(() => controller.abort(), 400);
		const events = await pending;
		const error = last(events) as Extract<AssistantMessageEvent, { type: "error" }>;
		assert.equal(error.reason, "aborted");
		assert.ok(Date.now() - started < 10_000, "did not wait for the child to finish");
	});

	it("does not run a model that is not a CLI model", async () => {
		const other = piModels().getModel("anthropic", "claude-sonnet-5-5")!;
		const events = await collect(claudeCliStream()(other, norm(ctx()), {}));
		assert.match((last(events) as Extract<AssistantMessageEvent, { type: "error" }>).error.errorMessage ?? "", /not a Claude CLI model/);
		assert.equal(calls().length, 0);
	});
});

describe("the seams", () => {
	it("builds an engine for a claude-cli spec that streams through the CLI", async () => {
		process.env.FAKE_CLI_STDOUT = ok({ text: "Engine says hi.", tool_calls: [] }, { stop_reason: "end_turn" });
		const engine = piEngineForSpec({ provider: CLAUDE_CLI_PROVIDER, id: "claude-sonnet-5-5", thinkingLevel: "medium" });
		assert.equal(engine.model.provider, CLAUDE_CLI_PROVIDER);
		assert.equal(engine.level, "medium");
		const done = last(await collect(engine.streamFn(engine.model, norm(ctx()), {}))) as Extract<AssistantMessageEvent, { type: "done" }>;
		assert.equal((done.message.content[0] as { text: string }).text, "Engine says hi.");
		assert.equal(calls()[0]!.args[calls()[0]!.args.indexOf("--effort") + 1], "medium", "the engine's thinking level reaches the CLI");
		assert.throws(() => piEngineForSpec({ provider: CLAUDE_CLI_PROVIDER, id: "no-such-model" }), /catalog has no model no-such-model/);
	});

	it("counts the CLI as a keyed provider only while it is installed", async () => {
		const { providerKeyPresent } = await import("../src/server/keys.ts");
		const { catalogProviders, modelCatalog } = await import("../src/server/model-catalog.ts");
		assert.equal(providerKeyPresent(CLAUDE_CLI_PROVIDER), true);
		assert.equal(catalogProviders().find((p) => p.id === CLAUDE_CLI_PROVIDER)?.keyPresent, true);
		assert.deepEqual(modelCatalog().models.filter((m) => m.provider === CLAUDE_CLI_PROVIDER).map((m) => m.id), [...CLAUDE_CLI_MODEL_IDS]);

		process.env.LEARNBOX_CLAUDE_BIN = path.join(tmp, "nothing-here");
		assert.equal(providerKeyPresent(CLAUDE_CLI_PROVIDER), false);
		assert.equal(catalogProviders().find((p) => p.id === CLAUDE_CLI_PROVIDER)?.keyPresent, false);
		assert.equal(modelCatalog().models.some((m) => m.provider === CLAUDE_CLI_PROVIDER), false, "no CLI, no CLI models in the picker");
	});

	it("accepts claude-cli models in the settings the user saves", async () => {
		const { validateModelsSettings } = await import("../src/server/model-catalog.ts");
		const slot = { model: { provider: CLAUDE_CLI_PROVIDER, id: "claude-sonnet-5-5" } };
		const result = validateModelsSettings({ strong: slot, cheap: { model: { provider: CLAUDE_CLI_PROVIDER, id: "claude-haiku-5-5" } }, vision: slot });
		assert.equal(result.ok, true);
		assert.equal(validateModelsSettings({ strong: { model: { provider: CLAUDE_CLI_PROVIDER, id: "claude-nope" } } }).ok, false);
	});
});

// ─── streaming and warm processes ────────────────────────────────────────────

/** A fake STREAMING `claude`: one process, many user messages. Each message is logged with
 *  the process id and answered with streamed text deltas and a result. */
const FAKE_STREAM_SOURCE = `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ spawn: true, pid: process.pid, args: process.argv.slice(2) }) + "\\n");
let buf = "", n = 0;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		const message = JSON.parse(line).message.content;
		fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ pid: process.pid, message }) + "\\n");
		n++;
		const answer = { text: "Answer " + n + " with \\"quotes\\" and\\nnewline.", tool_calls: process.env.FAKE_STREAM_TOOL ? [{ name: "probe", arguments: { question: "Why " + n + "?" } }] : [] };
		const json = JSON.stringify(answer);
		out({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "StructuredOutput" } } });
		for (let k = 0; k < json.length; k += 7) out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: json.slice(k, k + 7) } } });
		out({ type: "result", is_error: false, stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 9 }, structured_output: answer, result: "" });
	}
});
`;

describe("streaming and warm processes", () => {
	const streamFake = path.join(tmp, "claude-stream");
	before(() => {
		fs.writeFileSync(streamFake, FAKE_STREAM_SOURCE, { mode: 0o755 });
	});
	beforeEach(() => {
		closeClaudeCliProcesses();
		delete process.env.LEARNBOX_CLAUDE_PERSISTENT;
		process.env.LEARNBOX_CLAUDE_BIN = streamFake;
		delete process.env.FAKE_STREAM_TOOL;
		fs.rmSync(log, { force: true });
	});
	after(() => {
		closeClaudeCliProcesses();
		process.env.LEARNBOX_CLAUDE_PERSISTENT = "0";
		delete process.env.FAKE_STREAM_TOOL;
	});
	const entries = () => calls() as unknown as { spawn?: boolean; pid: number; message?: string; args?: string[] }[];

	it("decodes the streamed text field, even mid-escape", () => {
		assert.equal(structuredTextSoFar('{"text": "ab'), "ab");
		assert.equal(structuredTextSoFar('{"text":"a\\nb \\"q\\" \\u00e9'), 'a\nb "q" \u00e9');
		assert.equal(structuredTextSoFar('{"text":"half \\'), "half ");
		assert.equal(structuredTextSoFar('{"text":"half \\u00'), "half ");
		assert.equal(structuredTextSoFar('{"text":"done","tool_calls":[]}'), "done");
		assert.equal(structuredTextSoFar('{"tool_calls":[],"text":"x"}'), "");
	});

	it("streams the text as deltas before the answer is complete, then the tool calls", async () => {
		process.env.FAKE_STREAM_TOOL = "1";
		const events = await run(ctx());
		const deltas = events.filter((e) => e.type === "text_delta");
		assert.ok(deltas.length > 2, "the text arrives in pieces");
		const end = events.find((e) => e.type === "text_end");
		assert.equal(end?.type === "text_end" && end.content, 'Answer 1 with "quotes" and\nnewline.');
		assert.equal(deltas.map((e) => (e.type === "text_delta" ? e.delta : "")).join(""), 'Answer 1 with "quotes" and\nnewline.');
		const call = events.find((e) => e.type === "toolcall_end");
		assert.deepEqual(call?.type === "toolcall_end" && call.toolCall.arguments, { question: "Why 1?" });
		assert.equal(last(events).type, "done");
		const args = entries().find((e) => e.spawn)!.args!;
		assert.ok(args.includes("--include-partial-messages"));
		assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
	});

	it("keeps the process warm and sends only the new entries on the next call", async () => {
		process.env.FAKE_STREAM_TOOL = "1";
		const first = await run(ctx());
		const answer = (last(first) as { message: AssistantMessage }).message;
		const call = answer.content.find((b) => b.type === "toolCall")!;
		assert.equal(warmClaudeCliProcessCount(), 1);

		const messages: Context["messages"] = [
			...ctx().messages,
			answer,
			{ role: "toolResult", toolCallId: (call as { id: string }).id, toolName: "probe", content: [{ type: "text", text: "Because." }], isError: false, timestamp: 5 },
		];
		const second = await run(ctx({ messages }));
		assert.equal(last(second).type, "done");

		const log = entries();
		assert.equal(log.filter((e) => e.spawn).length, 1, "one process served both calls");
		const sent = log.filter((e) => e.message !== undefined).map((e) => e.message!);
		assert.equal(sent.length, 2);
		assert.match(sent[0]!, /Teach me the Nernst equation/);
		assert.match(sent[1]!, /Because\./);
		assert.doesNotMatch(sent[1]!, /Teach me the Nernst equation/, "the history is not resent");
		assert.match(sent[1]!, /^<transcript-continued>/);
	});

	it("starts a fresh process when the transcript is not a continuation (e.g. after compaction)", async () => {
		await run(ctx());
		await run(ctx({ messages: [{ role: "user", content: "A completely different start.", timestamp: 1 }] }));
		assert.equal(entries().filter((e) => e.spawn).length, 2);
	});

	it("does not share a process across different system prompts", async () => {
		await run(ctx());
		await run(ctx({ systemPrompt: "You are the prober." }));
		assert.equal(entries().filter((e) => e.spawn).length, 2);
	});

	it("closes the warm processes on request", async () => {
		await run(ctx());
		assert.equal(warmClaudeCliProcessCount(), 1);
		closeClaudeCliProcesses();
		assert.equal(warmClaudeCliProcessCount(), 0);
	});

	it("kills the process when a call is aborted", async () => {
		const controller = new AbortController();
		const pending = run(ctx(), { signal: controller.signal });
		controller.abort();
		const events = await pending;
		assert.equal((last(events) as { reason?: string }).reason, "aborted");
		assert.equal(warmClaudeCliProcessCount(), 0);
	});
});
