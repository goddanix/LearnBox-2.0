/**
 * The lecture library service (Learnbox, 2026-10): upload → store → read the
 * page count, then outline on request. The store keeps the bytes and the
 * record; this layer adds what it may not do itself (store → agent is not a
 * lawful direction): opening the PDF to learn it is a real, parseable
 * document, and running the outliner. An unreadable file is removed again,
 * so the library never holds a PDF nobody can read.
 *
 * Outline runs are background work with one in-memory handle per lecture
 * (the record carries status + progress, so the UI polls the list). A
 * record that says "outlining" with no live handle was cut off by a restart;
 * the listing reports it as failed instead of showing a spinner forever.
 */

import {
	DEFAULT_LECTURE_DEPTH,
	LECTURE_DEPTHS,
	LibraryError,
	type LectureDepth,
	type LectureSource,
	type SessionLecture,
} from "../core/contracts.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError, ROLE_SLOT } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { pdfPageCount } from "../agent/subagents/pdf-ops.ts";
import { buildLectureOutline } from "../agent/subagents/lecture-outline.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

export interface AddLectureResult {
	source: LectureSource;
	duplicate: boolean;
}

export async function addLecture(fileName: string, data: Uint8Array): Promise<AddLectureResult> {
	const { libraryStore } = stores;
	const added = libraryStore.add({ fileName, data });
	if (added.duplicate || added.source.pages !== null) return added;

	const file = libraryStore.pdfPath(added.source.id);
	try {
		if (!file) throw new Error("stored file missing");
		const pages = await pdfPageCount(file);
		const source = libraryStore.update(added.source.id, { pages });
		return { source: source ?? added.source, duplicate: false };
	} catch (err) {
		libraryStore.remove(added.source.id);
		const reason = err instanceof Error ? err.message : String(err);
		throw new LibraryError("unreadable", `The PDF could not be opened: ${reason}`);
	}
}

/** The outliner reads PDFs, so it runs on the pdfReader role's slot. Refuses
 *  honestly (the typed 503-envelope errors) when no model is set up or the
 *  provider's key is gone — read fresh, so a settings change lands at once. */
function resolveOutlineEngine(): PiEngine {
	const role = "pdfReader";
	const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
	if (!spec) throw new ModelsNotConfiguredError([ROLE_SLOT[role]]);
	const engine = piEngineForSpec(spec);
	if (!providerKeyPresent(engine.model.provider)) {
		throw new ProviderKeyMissingError(engine.model.provider, [ROLE_SLOT[role]]);
	}
	return engine;
}

/** What a failed (or cut-off) outline run leaves behind. A first run fails the
 *  lecture. A RE-run keeps the outline it was replacing, and with it the
 *  lecture's usability: the lecture stays ready, with the failure noted. */
function outlineRunFailure(source: LectureSource, message: string): Pick<LectureSource, "status" | "error" | "progress"> {
	return source.outline
		? { status: "ready", error: `Re-creating the outline failed; the previous outline is kept. ${message}`, progress: undefined }
		: { status: "failed", error: message, progress: undefined };
}

/** Lectures with a live outline run, by id (the abort handle). */
const running = new Map<string, AbortController>();

export function listLectures(): LectureSource[] {
	return stores.libraryStore.list().map((source) => {
		if (source.status !== "outlining" || running.has(source.id)) return source;
		const patch = outlineRunFailure(source, "The outline run was interrupted (the app was closed). Run it again.");
		return stores.libraryStore.update(source.id, patch) ?? { ...source, ...patch };
	});
}

export function getLecture(id: string): LectureSource | null {
	return listLectures().find((s) => s.id === id) ?? null;
}

export function removeLecture(id: string): boolean {
	running.get(id)?.abort();
	running.delete(id);
	return stores.libraryStore.remove(id);
}

export interface StartOutlineOptions {
	/** Test seam: a scripted engine replaces the pdfReader slot's production one. */
	engine?: PiEngine;
	/** Test seam: resolves when the background run has settled. */
	onSettled?: (source: LectureSource | null) => void;
}

/**
 * Start the outline run for one lecture and return at once (status
 * "outlining"). Returns null for an unknown id; a run already in flight
 * returns the current record untouched. The engine is resolved BEFORE
 * anything is written, so a missing model or key refuses honestly here
 * (ModelsNotConfiguredError / ProviderKeyMissingError) with the lecture
 * left as it was.
 */
export function startOutline(id: string, opts: StartOutlineOptions = {}): LectureSource | null {
	const { libraryStore } = stores;
	const source = libraryStore.get(id);
	const file = libraryStore.pdfPath(id);
	if (!source || !file) return null;
	if (running.has(id)) return source;

	const engine = opts.engine ?? resolveOutlineEngine();
	const controller = new AbortController();
	running.set(id, controller);
	const started = libraryStore.update(id, { status: "outlining", error: undefined, progress: { done: 0, total: 0 } }) ?? source;

	void (async () => {
		try {
			const outline = await buildLectureOutline(file, {
				engine,
				abortSignal: controller.signal,
				onProgress: (done, total) => {
					if (running.get(id) === controller) libraryStore.update(id, { progress: { done, total } });
				},
			});
			if (running.get(id) !== controller) return; // removed or superseded meanwhile
			libraryStore.update(id, { status: "ready", outline, error: undefined, progress: undefined });
		} catch (err) {
			if (running.get(id) !== controller || controller.signal.aborted) return;
			const current = libraryStore.get(id);
			if (current) libraryStore.update(id, outlineRunFailure(current, err instanceof Error ? err.message : String(err)));
		} finally {
			if (running.get(id) === controller) running.delete(id);
			opts.onSettled?.(libraryStore.get(id));
		}
	})();
	return started;
}

const MAX_SESSION_LECTURES = 8;
const MAX_SESSION_TOPICS = 80;

/**
 * Turn a client's lecture pick into what the session carries. The body is
 * untrusted: unknown lectures, lectures without a finished outline, unknown
 * topic ids, repeats and bad depths are dropped (a bad depth falls back to the
 * default), counts are capped, and topics keep the outline's page order. The
 * topic text (title, summary, pages) always comes from the stored outline,
 * never from the request. A lecture left with no topic is omitted; nothing
 * valid → an empty list, and the caller starts the session without lectures.
 */
export function resolveLectureSelection(raw: unknown): SessionLecture[] {
	const picked = (raw as { lectures?: unknown } | null | undefined)?.lectures;
	if (!Array.isArray(picked)) return [];
	const lectures: SessionLecture[] = [];
	const seen = new Set<string>();
	for (const entry of picked.slice(0, MAX_SESSION_LECTURES)) {
		const id = (entry as { id?: unknown } | null)?.id;
		if (typeof id !== "string" || seen.has(id) || !/^[A-Za-z0-9_-]+$/.test(id)) continue;
		seen.add(id);
		const source = stores.libraryStore.get(id);
		const file = stores.libraryStore.pdfPath(id);
		if (!source?.outline || source.status !== "ready" || !file) continue;

		const wanted = new Map<string, LectureDepth>();
		const topics = (entry as { topics?: unknown }).topics;
		if (!Array.isArray(topics)) continue;
		for (const t of topics.slice(0, MAX_SESSION_TOPICS)) {
			const topicId = (t as { id?: unknown } | null)?.id;
			if (typeof topicId !== "string" || wanted.has(topicId)) continue;
			const depth = (t as { depth?: unknown }).depth;
			wanted.set(topicId, (LECTURE_DEPTHS as readonly unknown[]).includes(depth) ? (depth as LectureDepth) : DEFAULT_LECTURE_DEPTH);
		}
		const chosen = source.outline.topics
			.filter((t) => wanted.has(t.id))
			.sort((a, b) => a.pageStart - b.pageStart)
			.map((t) => ({ ...t, depth: wanted.get(t.id)! }));
		if (chosen.length === 0) continue;
		lectures.push({ id, title: source.title, fileName: source.fileName, pages: source.pages, path: file, topics: chosen });
	}
	return lectures;
}
