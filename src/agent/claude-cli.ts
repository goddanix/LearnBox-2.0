import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	JsonObject,
	Message,
	Model,
	Models,
	SimpleStreamOptions,
	StreamFunction,
	TextContent,
	ToolCall,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

/**
 * The Claude CLI provider (Learnbox, 2026-10): models served by the learner's
 * own Claude Code login (`claude -p`) instead of an API key. The plan's usage
 * limits apply, not per-token billing, and no key is read or stored.
 *
 * The CLI runs its own agent loop and cannot hand tool calls back to ours, so
 * each model call is ONE non-interactive, tool-less CLI call that returns a
 * structured answer — {text, tool_calls[]} — through `--json-schema`; the
 * calling agent loop (pi-agent-core) executes the tool calls and sends the
 * results in the next call, exactly as with an API provider. The whole
 * conversation travels on stdin as a transcript; the system prompt replaces
 * Claude Code's own. Calls are isolated from the user's Claude Code setup
 * (no settings, hooks, skills, MCP servers or CLAUDE.md of the working
 * directory) so the learner's personal configuration never leaks into a
 * lesson.
 *
 * Speed (Learnbox, 2026-10): a CLI start costs ~2.5 s, so the CLI processes stay
 * alive between calls — one warm process per (model, effort, system prompt, schema),
 * kept while the app runs and closed with it. A warm process keeps its own
 * conversation, so a follow-up call sends only the transcript entries that are new
 * since its last answer; any mismatch (compaction, edits, a restart) falls back to a
 * fresh process with the full transcript. The answer's `text` streams as the CLI
 * produces it; tool calls arrive when complete. LEARNBOX_CLAUDE_PERSISTENT=0 returns
 * to one cold, non-streaming CLI call per model call (also used for image requests
 * and system prompts too large for argv).
 *
 * Trade-offs, stated plainly: every call carries ~1k tokens of CLI overhead, warm
 * processes hold memory while the app is open, and the plan's rate limits are
 * shared with everything else the learner does in Claude.
 */

export const CLAUDE_CLI_PROVIDER = "claude-cli";
/** The Claude models the CLI serves, by pi-ai catalog id. The CLI takes these ids as `--model`. */
export const CLAUDE_CLI_MODEL_IDS = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5"] as const;

/** Environment variables that would move the CLI off the learner's sign-in onto per-token billing.
 *  (CLAUDE_CODE_OAUTH_TOKEN stays: it is a subscription token, not an API key.) */
export const API_BILLING_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_BEDROCK_BASE_URL",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
] as const;

const MAX_PARALLEL = Math.max(1, Number(process.env.LEARNBOX_CLAUDE_CONCURRENCY) || 3);
const CALL_TIMEOUT_MS = 10 * 60_000;
/** Above this the system prompt moves from argv to the top of stdin (argv has a hard total limit). */
const MAX_ARGV_SYSTEM_CHARS = 250_000;

// ─── the binary ──────────────────────────────────────────────────────────────

let binaryCache: { path: string | null; at: number } | undefined;
const BINARY_RECHECK_MS = 10_000;

function isExecutable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/** Where `claude` lives. A packaged Electron app has a minimal PATH (no nvm, no
 *  Homebrew), so PATH alone is not enough: env override → PATH → the usual
 *  install locations → the user's login shell, as a last resort. */
export function resolveClaudeBinary(): string | null {
	// An explicit override is the ONLY candidate: pointing it at nothing means
	// "no CLI here", never a quiet fallback to some other claude on the machine.
	if (process.env.LEARNBOX_CLAUDE_BIN) {
		const explicit = process.env.LEARNBOX_CLAUDE_BIN;
		return isExecutable(explicit) ? explicit : null;
	}
	if (binaryCache && Date.now() - binaryCache.at < BINARY_RECHECK_MS) return binaryCache.path;
	const home = os.homedir();
	const candidates: string[] = [];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) if (dir) candidates.push(path.join(dir, "claude"));
	candidates.push(
		path.join(home, ".claude", "local", "claude"),
		path.join(home, ".local", "bin", "claude"),
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
		path.join(home, ".volta", "bin", "claude"),
	);
	try {
		const nvm = path.join(home, ".nvm", "versions", "node");
		for (const version of fs.readdirSync(nvm).sort().reverse()) candidates.push(path.join(nvm, version, "bin", "claude"));
	} catch {
		/* no nvm */
	}
	let found = candidates.find(isExecutable) ?? null;
	if (!found) {
		try {
			const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", "command -v claude"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
			const last = out.split("\n").pop() ?? "";
			if (last && isExecutable(last)) found = last;
		} catch {
			/* no login-shell hit */
		}
	}
	binaryCache = { path: found, at: Date.now() };
	return found;
}

/** Is the CLI installed here? (Whether it is logged in only shows on the first call.) */
export function claudeCliAvailable(): boolean {
	return resolveClaudeBinary() !== null;
}

/** Test seam: forget the cached binary lookup. */
export function resetClaudeCliCache(): void {
	binaryCache = undefined;
}

// ─── the models ──────────────────────────────────────────────────────────────

/** One CLI model: pi-ai's anthropic catalog entry under this provider, cost zeroed
 *  (the plan pays, not a per-token bill). Undefined for ids the CLI list does not carry. */
export function claudeCliModel(models: Models, id: string): Model<Api> | undefined {
	if (!(CLAUDE_CLI_MODEL_IDS as readonly string[]).includes(id)) return undefined;
	const base = models.getModel("anthropic", id);
	if (!base) return undefined;
	return { ...base, provider: CLAUDE_CLI_PROVIDER, name: `${base.name} (Claude CLI)`, headers: undefined, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
}

export function claudeCliModels(models: Models): Model<Api>[] {
	return CLAUDE_CLI_MODEL_IDS.flatMap((id) => {
		const model = claudeCliModel(models, id);
		return model ? [model] : [];
	});
}

// ─── the request ─────────────────────────────────────────────────────────────

const PROTOCOL = `

## How you answer in this application
You are one component of an application, called through a text interface. You have NO native tools in this session: do not try to call any tool directly, and never say that a tool is unavailable. The application's tools are listed below as DATA. The application runs them for you; you ask for them in your structured answer.
Answer ONLY through the structured output:
- "text": prose you want recorded as your own text this turn (may be empty).
- "tool_calls": the application tools you want run now, in order — zero or more. Each is {"name", "arguments"}; the arguments must satisfy that tool's JSON schema exactly. Leave the list empty only when you have nothing more to do this turn.
The conversation so far arrives as a transcript. Results of tools you asked for appear as [tool_result] entries. Do not repeat a tool call whose result is already in the transcript unless the task needs it again. Do not write the transcript's bracket markers ([user], [assistant], [tool_call], [tool_result]) yourself.`;

interface BuiltRequest {
	system: string;
	prompt: string;
	/** The transcript body alone (prompt = it, wrapped): what a warm process is diffed against. */
	history: string;
	schema: object;
	imageDir: string | null;
}

function textOf(blocks: readonly (TextContent | ImageContent)[], imageDir: () => string, images: string[]): string {
	return blocks
		.map((block) => {
			if (block.type === "text") return block.text;
			const file = path.join(imageDir(), `image-${images.length + 1}.${block.mimeType.includes("jpeg") ? "jpg" : "png"}`);
			fs.writeFileSync(file, Buffer.from(block.data, "base64"));
			images.push(file);
			return `[image attached: ${file}]`;
		})
		.join("\n");
}

/** The transcript the CLI is asked to continue. Thinking blocks are not replayed. */
function transcript(messages: readonly Message[], imageDir: () => string, images: string[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		// System messages carry the prompt and the tool declarations; they are
		// replayed into the system prompt and the tool list, not into the transcript.
		if (message.role === "system") continue;
		if (message.role === "user") {
			const body = typeof message.content === "string" ? message.content : textOf(message.content, imageDir, images);
			parts.push(`[user]\n${body}`);
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim()) parts.push(`[assistant]\n${block.text}`);
				else if (block.type === "toolCall") parts.push(`[tool_call id=${block.id} name=${block.name}]\n${JSON.stringify(block.arguments)}`);
			}
		} else if (message.role === "toolResult") {
			const body = textOf(message.content, imageDir, images);
			parts.push(`[tool_result id=${message.toolCallId} name=${message.toolName}${message.isError ? " error=true" : ""}]\n${body}`);
		}
	}
	return parts.join("\n\n");
}

const CONTINUE = "Continue as the assistant: give your next structured answer now.";
const firstPrompt = (history: string) => `<transcript>\n${history}\n</transcript>\n\n${CONTINUE}`;
const deltaPrompt = (entries: string) => `<transcript-continued>\n${entries}\n</transcript-continued>\n\nThe conversation above continues with these new entries. ${CONTINUE}`;

/** The transcript lines for one assistant answer, exactly as transcript() writes them for the record. */
function answerTranscript(text: string, calls: readonly ToolCall[]): string {
	const parts: string[] = [];
	if (text.trim()) parts.push(`[assistant]\n${text}`);
	for (const call of calls) parts.push(`[tool_call id=${call.id} name=${call.name}]\n${JSON.stringify(call.arguments)}`);
	return parts.join("\n\n");
}

/** The structured-output schema: prose plus tool calls restricted to the tools on offer. */
export function answerSchema(toolNames: readonly string[]): object {
	if (toolNames.length === 0) {
		return { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };
	}
	return {
		type: "object",
		properties: {
			text: { type: "string" },
			tool_calls: {
				type: "array",
				items: {
					type: "object",
					properties: { name: { type: "string", enum: [...toolNames] }, arguments: { type: "object" } },
					required: ["name", "arguments"],
				},
			},
		},
		required: ["text", "tool_calls"],
	};
}

/** The agent hands providers a TRANSCRIPT: the system prompt and the tool
 *  declarations ride in its leading system messages (pi-ai's normalizeContext),
 *  not as separate fields. Replaying them gives the current prompt and tools. */
export function buildRequest(context: TranscriptContext): BuiltRequest {
	const tools = getCurrentTools(context.messages);
	let dir: string | null = null;
	const imageDir = () => (dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "learnbox-images-")));
	const images: string[] = [];
	const history = transcript(context.messages, imageDir, images);

	const toolBlock = tools.length
		? `\n\n## Application tools (not native tools: ask for them ONLY in "tool_calls" of your structured answer)\n${JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })))}`
		: "";
	const imageNote = images.length ? "\n\nImages in the transcript are files; open each with the Read tool before you rely on it." : "";
	const system = `${getCurrentSystemPrompt(context.messages)}${PROTOCOL}${toolBlock}${imageNote}`;
	return { system, prompt: firstPrompt(history), history, schema: answerSchema(tools.map((t) => t.name)), imageDir: dir };
}

/** pi thinking levels → the CLI's --effort scale. */
export function cliEffort(reasoning: string | undefined): string | undefined {
	if (!reasoning || reasoning === "off") return undefined;
	return reasoning === "minimal" ? "low" : reasoning;
}

// ─── running the CLI ─────────────────────────────────────────────────────────

interface CliAnswer {
	text: string;
	toolCalls: { name: string; arguments: unknown }[];
	usage: Usage;
	stopReason: "stop" | "toolUse" | "length";
}

class CliFailure extends Error {
	constructor(message: string, readonly kind: "missing" | "auth" | "limit" | "aborted" | "other" = "other") {
		super(message);
	}
}

/** The learner-facing wording of a CLI failure — never a stack trace. */
export function claudeCliErrorText(message: string, kind: CliFailure["kind"]): string {
	if (kind === "missing") return "The Claude CLI was not found. Install Claude Code, then run `claude` once in Terminal and sign in. No API key is used as a fallback.";
	if (kind === "auth" || /not logged in|please run \/login|\/login|invalid.*(api key|token)|oauth|authentication/i.test(message)) {
		return "The Claude CLI is not signed in. Open Terminal, run `claude`, and sign in with your Claude account. No API key is used as a fallback.";
	}
	if (kind === "limit" || /usage limit|rate limit|limit reached|too many requests|429|overloaded|529/i.test(message)) {
		return "Your Claude plan's usage limit is reached (or Claude is overloaded). Wait for the limit to reset, then retry. No API key is used as a fallback.";
	}
	if (kind === "aborted") return "The Claude CLI request was cancelled.";
	return `Claude CLI error: ${message.slice(0, 400)}`;
}

let active = 0;
const waiting: (() => void)[] = [];
async function slot(signal: AbortSignal | undefined): Promise<() => void> {
	if (active >= MAX_PARALLEL) {
		await new Promise<void>((resolve, reject) => {
			const entry = () => resolve();
			waiting.push(entry);
			signal?.addEventListener("abort", () => {
				const i = waiting.indexOf(entry);
				if (i >= 0) waiting.splice(i, 1);
				reject(new CliFailure("cancelled while waiting", "aborted"));
			}, { once: true });
		});
	}
	active++;
	return () => {
		active--;
		waiting.shift()?.();
	};
}

function usageFrom(raw: Record<string, unknown> | undefined): Usage {
	const n = (key: string) => (typeof raw?.[key] === "number" ? (raw[key] as number) : 0);
	const input = n("input_tokens");
	const output = n("output_tokens");
	const cacheRead = n("cache_read_input_tokens");
	const cacheWrite = n("cache_creation_input_tokens");
	const details = raw?.output_tokens_details as Record<string, unknown> | undefined;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(typeof details?.thinking_tokens === "number" ? { reasoning: details.thinking_tokens } : {}),
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** The CLI's JSON result → our answer. Exported for tests. */
export function parseCliResult(stdout: string): CliAnswer {
	let result: Record<string, unknown>;
	try {
		result = JSON.parse(stdout) as Record<string, unknown>;
	} catch {
		throw new CliFailure(`unreadable CLI output: ${stdout.slice(0, 200)}`);
	}
	if (result.is_error === true) {
		const text = typeof result.result === "string" ? result.result : "the CLI reported an error";
		const status = result.api_error_status;
		throw new CliFailure(text, status === 401 || status === 403 ? "auth" : status === 429 || status === 529 ? "limit" : "other");
	}
	let answer = result.structured_output as Record<string, unknown> | undefined;
	if (!answer && typeof result.result === "string") {
		try {
			answer = JSON.parse(result.result) as Record<string, unknown>;
		} catch {
			// no structured output at all: treat the prose as the answer's text
			answer = { text: result.result, tool_calls: [] };
		}
	}
	if (!answer || typeof answer !== "object") throw new CliFailure("the CLI returned no answer");
	const calls = Array.isArray(answer.tool_calls) ? answer.tool_calls : [];
	const toolCalls = calls.flatMap((c) => {
		const call = c as { name?: unknown; arguments?: unknown };
		return typeof call?.name === "string" ? [{ name: call.name, arguments: call.arguments }] : [];
	});
	const stopReason = result.stop_reason === "max_tokens" ? "length" : toolCalls.length > 0 ? "toolUse" : "stop";
	return { text: typeof answer.text === "string" ? answer.text : "", toolCalls, usage: usageFrom(result.usage as Record<string, unknown> | undefined), stopReason };
}

async function runCli(model: Model<Api>, request: BuiltRequest, effort: string | undefined, signal: AbortSignal | undefined): Promise<CliAnswer> {
	const binary = resolveClaudeBinary();
	if (!binary) throw new CliFailure("claude binary not found", "missing");
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "learnbox-cli-"));
	const releaseSlot = await slot(signal);
	try {
		const systemInArgv = request.system.length <= MAX_ARGV_SYSTEM_CHARS;
		const stdin = systemInArgv ? request.prompt : `<system>\n${request.system}\n</system>\n\n${request.prompt}`;
		const args = [
			"-p",
			"--output-format", "json",
			"--json-schema", JSON.stringify(request.schema),
			"--model", model.id,
			"--no-session-persistence",
			"--setting-sources", "",
			"--strict-mcp-config",
			"--disable-slash-commands",
			"--system-prompt", systemInArgv ? request.system : "Follow the system instructions given at the top of the user message.",
			...(request.imageDir ? ["--tools", "Read", "--allowedTools", "Read", "--add-dir", request.imageDir] : ["--tools", ""]),
			...(effort ? ["--effort", effort] : []),
		];
		const binDir = path.dirname(binary);
		const env: NodeJS.ProcessEnv = { ...process.env, PATH: [binDir, process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(path.delimiter) };
		// The CLI must run on the learner's sign-in, never on a key: an API key (or
		// a cloud-provider switch) in the environment would make it bill per token.
		for (const name of API_BILLING_ENV) delete env[name];
		return await new Promise<CliAnswer>((resolve, reject) => {
			const child = spawn(binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
			let out = "";
			let err = "";
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				fn();
			};
			const onAbort = () => {
				child.kill("SIGTERM");
				finish(() => reject(new CliFailure("cancelled", "aborted")));
			};
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				finish(() => reject(new CliFailure(`the Claude CLI did not answer within ${CALL_TIMEOUT_MS / 60000} minutes`)));
			}, CALL_TIMEOUT_MS);
			if (signal?.aborted) return onAbort();
			signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (err += d));
			child.on("error", (e) => finish(() => reject(new CliFailure(e.message, (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "other"))));
			child.on("close", (code) => {
				finish(() => {
					if (out.trim()) {
						try {
							resolve(parseCliResult(out));
						} catch (e) {
							reject(e);
						}
						return;
					}
					reject(new CliFailure(err.trim() || `the CLI exited with code ${code} and no output`));
				});
			});
			child.stdin.on("error", () => {});
			child.stdin.end(stdin);
		});
	} finally {
		releaseSlot();
		fs.rmSync(cwd, { recursive: true, force: true });
		if (request.imageDir) fs.rmSync(request.imageDir, { recursive: true, force: true });
	}
}

// ─── streaming and the warm processes ────────────────────────────────────────

/** The `text` field of the structured answer, decoded as far as the partial JSON reaches.
 *  The schema lists `text` first, so it streams before any tool call. */
export function structuredTextSoFar(partial: string): string {
	const start = /^\s*\{\s*"text"\s*:\s*"/.exec(partial);
	if (!start) return "";
	let out = "";
	const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "/": "/", "\\": "\\", '"': '"' };
	for (let i = start[0].length; i < partial.length; i++) {
		const ch = partial[i]!;
		if (ch === '"') break;
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		const next = partial[i + 1];
		if (next === undefined) break;
		if (next === "u") {
			const hex = partial.slice(i + 2, i + 6);
			if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
			out += String.fromCharCode(parseInt(hex, 16));
			i += 5;
		} else {
			out += escapes[next] ?? next;
			i += 1;
		}
	}
	return out;
}

/** Ids and normalized arguments for the answer's tool calls — assigned once, so the
 *  record and a warm process's memory of the answer agree. */
function finalizeCalls(answer: CliAnswer): ToolCall[] {
	return answer.toolCalls.map((raw) => {
		const isObject = raw.arguments !== null && typeof raw.arguments === "object" && !Array.isArray(raw.arguments);
		return {
			type: "toolCall",
			id: `call_${randomUUID().slice(0, 12)}`,
			name: raw.name,
			arguments: (isObject ? raw.arguments : {}) as JsonObject,
			...(isObject ? {} : { argumentsError: `the tool arguments were not a JSON object: ${JSON.stringify(raw.arguments)?.slice(0, 200)}` }),
		};
	});
}

interface CliRun {
	answer: CliAnswer;
	calls: ToolCall[];
}

interface Warm {
	key: string;
	child: ChildProcess;
	cwd: string;
	busy: boolean;
	dead: boolean;
	/** The transcript this process has already seen, through its own last answer. */
	seen: string;
	stderr: string;
	onLine: ((line: string) => void) | null;
	onExit: ((code: number | null) => void) | null;
}

const MAX_WARM = 3;
const warm: Warm[] = [];
let exitHooked = false;

const persistentEnabled = () => process.env.LEARNBOX_CLAUDE_PERSISTENT !== "0";

function discard(entry: Warm): void {
	entry.dead = true;
	const at = warm.indexOf(entry);
	if (at >= 0) warm.splice(at, 1);
	try {
		entry.child.kill("SIGTERM");
	} catch {
		/* already gone */
	}
	fs.rmSync(entry.cwd, { recursive: true, force: true });
}

/** Close every warm CLI process. Also runs when the app's server exits; a process whose
 *  parent died ends by itself anyway, because its stdin closes. */
export function closeClaudeCliProcesses(): void {
	for (const entry of [...warm]) discard(entry);
}

/** How many warm processes are alive (tests, diagnostics). */
export function warmClaudeCliProcessCount(): number {
	return warm.length;
}

function hookExit(): void {
	if (exitHooked) return;
	exitHooked = true;
	process.once("exit", closeClaudeCliProcesses);
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.once(signal, () => {
			closeClaudeCliProcesses();
			// Keep the default "end the process" when nobody else handles the signal.
			if (process.listenerCount(signal) === 0) process.exit(0);
		});
	}
}

function cliEnv(binary: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: [path.dirname(binary), process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(path.delimiter) };
	// The CLI must run on the learner's sign-in, never on a key: an API key (or
	// a cloud-provider switch) in the environment would make it bill per token.
	for (const name of API_BILLING_ENV) delete env[name];
	return env;
}

function spawnWarm(binary: string, key: string, model: Model<Api>, request: BuiltRequest, effort: string | undefined): Warm {
	hookExit();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "learnbox-cli-"));
	const args = [
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--json-schema", JSON.stringify(request.schema),
		"--model", model.id,
		"--no-session-persistence",
		"--setting-sources", "",
		"--strict-mcp-config",
		"--disable-slash-commands",
		"--system-prompt", request.system,
		"--tools", "",
		...(effort ? ["--effort", effort] : []),
	];
	const child = spawn(binary, args, { cwd, env: cliEnv(binary), stdio: ["pipe", "pipe", "pipe"] });
	const entry: Warm = { key, child, cwd, busy: true, dead: false, seen: "", stderr: "", onLine: null, onExit: null };
	let pending = "";
	child.stdout.on("data", (chunk: Buffer) => {
		pending += chunk;
		let at: number;
		while ((at = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, at);
			pending = pending.slice(at + 1);
			if (line.trim()) entry.onLine?.(line);
		}
	});
	child.stderr.on("data", (chunk: Buffer) => {
		entry.stderr = (entry.stderr + chunk).slice(-4000);
	});
	child.stdin.on("error", () => {});
	child.on("error", (e) => {
		entry.stderr += e.message;
		entry.dead = true;
		entry.onExit?.(null);
	});
	child.on("close", (code) => {
		entry.dead = true;
		const at = warm.indexOf(entry);
		if (at >= 0) warm.splice(at, 1);
		fs.rmSync(entry.cwd, { recursive: true, force: true });
		entry.onExit?.(code);
	});
	warm.push(entry);
	return entry;
}

/** One request/answer exchange on a process: send a user message, read events until the result. */
function exchange(entry: Warm, prompt: string, signal: AbortSignal | undefined, onText: (delta: string) => void): Promise<CliAnswer> {
	return new Promise<CliAnswer>((resolve, reject) => {
		let settled = false;
		let json = "";
		let emitted = "";
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			entry.onLine = null;
			entry.onExit = null;
			fn();
		};
		const onAbort = () => finish(() => reject(new CliFailure("cancelled", "aborted")));
		const timer = setTimeout(() => finish(() => reject(new CliFailure(`the Claude CLI did not answer within ${CALL_TIMEOUT_MS / 60000} minutes`))), CALL_TIMEOUT_MS);
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		entry.onExit = (code) => finish(() => reject(new CliFailure(entry.stderr.trim() || `the CLI exited with code ${code} and no output`, /ENOENT/.test(entry.stderr) ? "missing" : "other")));
		entry.onLine = (line) => {
			let message: { type?: string; event?: { type?: string; content_block?: { type?: string }; delta?: { type?: string; partial_json?: string } } };
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (message.type === "stream_event") {
				const event = message.event;
				if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") json = "";
				else if (event?.type === "content_block_delta" && event.delta?.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
					json += event.delta.partial_json;
					const text = structuredTextSoFar(json);
					if (text.length > emitted.length && text.startsWith(emitted)) {
						onText(text.slice(emitted.length));
						emitted = text;
					}
				}
			} else if (message.type === "result") {
				finish(() => {
					try {
						resolve(parseCliResult(line));
					} catch (e) {
						reject(e);
					}
				});
			}
		};
		entry.child.stdin!.write(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
	});
}

/** One model call. A warm process that has seen the transcript so far gets only the new
 *  entries; otherwise a fresh process gets all of it. Streams `text` through onText. */
async function runPersistent(binary: string, model: Model<Api>, request: BuiltRequest, effort: string | undefined, signal: AbortSignal | undefined, onText: (delta: string) => void): Promise<CliRun> {
	const key = createHash("sha1").update([binary, model.id, effort ?? "", request.system, JSON.stringify(request.schema)].join("\0")).digest("hex");
	const release = await slot(signal);
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			const reusable = attempt === 0 ? warm.find((w) => w.key === key && !w.busy && !w.dead && request.history.startsWith(`${w.seen}\n\n`)) : undefined;
			let entry: Warm;
			let prompt: string;
			if (reusable) {
				entry = reusable;
				entry.busy = true;
				prompt = deltaPrompt(request.history.slice(entry.seen.length + 2));
			} else {
				while (warm.length >= MAX_WARM) {
					const idle = warm.find((w) => !w.busy);
					if (!idle) break;
					discard(idle);
				}
				entry = spawnWarm(binary, key, model, request, effort);
				prompt = firstPrompt(request.history);
			}
			let streamed = false;
			try {
				const answer = await exchange(entry, prompt, signal, (delta) => {
					streamed = true;
					onText(delta);
				});
				const calls = finalizeCalls(answer);
				const rendered = answerTranscript(answer.text, calls);
				entry.seen = rendered ? `${request.history}\n\n${rendered}` : request.history;
				entry.busy = false;
				// Over the cap with every process busy: this one is not kept.
				if (warm.length > MAX_WARM) discard(entry);
				return { answer, calls };
			} catch (error) {
				discard(entry);
				// A warm process that died on its own before answering: retry once, fresh.
				if (reusable && !streamed && !signal?.aborted && !(error instanceof CliFailure && error.kind === "aborted")) continue;
				throw error;
			}
		}
		throw new CliFailure("the CLI could not be started");
	} finally {
		release();
	}
}

// ─── the stream ──────────────────────────────────────────────────────────────

function emptyMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: CLAUDE_CLI_PROVIDER,
		model: model.id,
		content: [],
		stopReason: "stop",
		timestamp: Date.now(),
		usage: usageFrom(undefined),
	};
}

/** The pi-ai StreamFunction for CLI models. One CLI call per model call. The answer's
 *  text streams while the CLI writes it; tool calls follow once the answer is complete. */
export function claudeCliStream(): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const stream = new AssistantMessageEventStream();
		void (async () => {
			const partial = emptyMessage(model);
			try {
				if (model.provider !== CLAUDE_CLI_PROVIDER) throw new CliFailure(`not a Claude CLI model: ${model.provider}:${model.id}`);
				const request = buildRequest(context);
				const effort = cliEffort(options?.reasoning);
				let started = false;
				let textIndex = -1;
				let streamed = "";
				const start = () => {
					if (started) return;
					started = true;
					stream.push({ type: "start", partial: { ...partial } });
				};
				const onText = (delta: string) => {
					start();
					if (textIndex < 0) {
						textIndex = partial.content.length;
						partial.content = [...partial.content, { type: "text", text: "" }];
						stream.push({ type: "text_start", contentIndex: textIndex, partial: { ...partial } });
					}
					streamed += delta;
					partial.content = [...partial.content.slice(0, textIndex), { type: "text", text: streamed }];
					stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: { ...partial } });
				};

				const binary = resolveClaudeBinary();
				if (!binary) throw new CliFailure("claude binary not found", "missing");
				const warmable = persistentEnabled() && !request.imageDir && request.system.length <= MAX_ARGV_SYSTEM_CHARS;
				const { answer, calls } = warmable
					? await runPersistent(binary, model, request, effort, options?.signal, onText)
					: await runCli(model, request, effort, options?.signal).then((a) => ({ answer: a, calls: finalizeCalls(a) }));

				start();
				if (answer.text.trim()) {
					if (textIndex < 0) {
						textIndex = partial.content.length;
						partial.content = [...partial.content, { type: "text", text: "" }];
						stream.push({ type: "text_start", contentIndex: textIndex, partial: { ...partial } });
						partial.content = [...partial.content.slice(0, textIndex), { type: "text", text: answer.text }];
						stream.push({ type: "text_delta", contentIndex: textIndex, delta: answer.text, partial: { ...partial } });
					} else {
						partial.content = [...partial.content.slice(0, textIndex), { type: "text", text: answer.text }];
					}
					stream.push({ type: "text_end", contentIndex: textIndex, content: answer.text, partial: { ...partial } });
				}
				for (const call of calls) {
					const index = partial.content.length;
					partial.content = [...partial.content, { ...call, arguments: {} }];
					stream.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } });
					partial.content = [...partial.content.slice(0, index), call];
					stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial: { ...partial } });
					stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: { ...partial } });
				}
				const message: AssistantMessage = { ...partial, usage: answer.usage, stopReason: answer.stopReason };
				stream.push({ type: "done", reason: answer.stopReason, message });
				stream.end(message);
			} catch (err) {
				const failure = err instanceof CliFailure ? err : new CliFailure(err instanceof Error ? err.message : String(err));
				const aborted = failure.kind === "aborted" || options?.signal?.aborted === true;
				const message: AssistantMessage = {
					...partial,
					stopReason: aborted ? "aborted" : "error",
					errorMessage: claudeCliErrorText(failure.message, aborted ? "aborted" : failure.kind),
				};
				stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
				stream.end(message);
			}
		})();
		return stream;
	};
}
