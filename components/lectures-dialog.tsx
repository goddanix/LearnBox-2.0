"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronRightIcon, FileTextIcon, UploadIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { LECTURE_DEPTHS, DEFAULT_LECTURE_DEPTH, type LectureDepth, type LectureSelection, type LectureSource } from "@/src/core";

/**
 * The lectures dialog (Learnbox, 2026-10): one surface for the whole
 * lecture flow, opened from the "Add lectures" pill above the composer.
 *
 *   upload PDFs → create each one's topic outline → tick the topics for
 *   THIS session and choose a depth per topic → Done
 *
 * The library (uploaded PDFs + outlines) is global and persists; the tick
 * state is the session's draft pick, owned by the caller (home / new
 * session) and sent with the session create as `lectureContext`. The
 * lectures are the curriculum, never the learner's knowledge — nothing here
 * touches the graph.
 */

// ─── The pick: lecture → topic → depth ───────────────────────────────────────

/** lectureId → topicId → depth. Absent topic = not picked. */
export type LecturePick = Record<string, Record<string, LectureDepth>>;

export const DEPTH_LABEL: Readonly<Record<LectureDepth, string>> = {
	overview: "Overview",
	mechanism: "Mechanism",
	derivation: "Derivation",
};

export function toggleTopic(pick: LecturePick, lectureId: string, topicId: string): LecturePick {
	const topics = { ...(pick[lectureId] ?? {}) };
	if (topics[topicId]) delete topics[topicId];
	else topics[topicId] = DEFAULT_LECTURE_DEPTH;
	return withLecture(pick, lectureId, topics);
}

export function setDepth(pick: LecturePick, lectureId: string, topicId: string, depth: LectureDepth): LecturePick {
	return withLecture(pick, lectureId, { ...(pick[lectureId] ?? {}), [topicId]: depth });
}

/** All of a lecture's topics when not all are picked, none when they all are. */
export function toggleLecture(pick: LecturePick, source: LectureSource): LecturePick {
	const topics = source.outline?.topics ?? [];
	const picked = pick[source.id] ?? {};
	const all = topics.length > 0 && topics.every((t) => picked[t.id]);
	return withLecture(pick, source.id, all ? {} : Object.fromEntries(topics.map((t) => [t.id, picked[t.id] ?? DEFAULT_LECTURE_DEPTH])));
}

/** Forget every picked topic of one lecture (its outline is being replaced, and
 *  topic ids are only numbered: an old pick would point at a different topic). */
export function clearLecture(pick: LecturePick, lectureId: string): LecturePick {
	return withLecture(pick, lectureId, {});
}

function withLecture(pick: LecturePick, lectureId: string, topics: Record<string, LectureDepth>): LecturePick {
	const next = { ...pick };
	if (Object.keys(topics).length === 0) delete next[lectureId];
	else next[lectureId] = topics;
	return next;
}

/** Drop picks whose lecture or topic no longer exists (a lecture was removed or re-outlined). */
export function prunePick(pick: LecturePick, sources: readonly LectureSource[]): LecturePick {
	const next: LecturePick = {};
	for (const source of sources) {
		const valid = new Set((source.outline?.topics ?? []).map((t) => t.id));
		const kept = Object.fromEntries(Object.entries(pick[source.id] ?? {}).filter(([id]) => valid.has(id)));
		if (Object.keys(kept).length > 0) next[source.id] = kept;
	}
	return next;
}

export function countPick(pick: LecturePick): { topics: number; lectures: number } {
	const lectures = Object.values(pick).filter((t) => Object.keys(t).length > 0);
	return { topics: lectures.reduce((n, t) => n + Object.keys(t).length, 0), lectures: lectures.length };
}

/** The request body's `lectureContext` — ids and depths only; the server reads the text from the outlines. */
export function pickRequest(pick: LecturePick): LectureSelection {
	return {
		lectures: Object.entries(pick)
			.filter(([, topics]) => Object.keys(topics).length > 0)
			.map(([id, topics]) => ({ id, topics: Object.entries(topics).map(([topicId, depth]) => ({ id: topicId, depth })) })),
	};
}

// ─── The library client ──────────────────────────────────────────────────────

interface UploadResult {
	fileName: string;
	ok: boolean;
	error?: string;
}

/** The library's list, its polling (while an outline runs) and its three actions. */
export function useLectureLibrary(enabled = true) {
	const [sources, setSources] = useState<LectureSource[]>([]);
	const [errors, setErrors] = useState<string[]>([]);
	const [uploading, setUploading] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/library");
			if (!res.ok) return;
			setSources(((await res.json()) as { sources: LectureSource[] }).sources);
		} catch {
			/* an unreachable library leaves the last list standing */
		}
	}, []);

	useEffect(() => {
		if (enabled) void refresh();
	}, [enabled, refresh]);

	const running = sources.some((s) => s.status === "outlining");
	useEffect(() => {
		if (!enabled || !running) return;
		const timer = setInterval(() => void refresh(), 2000);
		return () => clearInterval(timer);
	}, [enabled, running, refresh]);

	const upload = useCallback(
		async (files: File[]) => {
			const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
			const skipped = files.filter((f) => !pdfs.includes(f)).map((f) => `${f.name}: only PDF files can be added.`);
			setErrors(skipped);
			if (pdfs.length === 0) return;
			setUploading(true);
			try {
				const form = new FormData();
				for (const file of pdfs) form.append("files", file);
				const res = await fetch("/api/library", { method: "POST", body: form });
				const body = (await res.json()) as { results?: UploadResult[]; error?: string };
				const failed = (body.results ?? []).filter((r) => !r.ok).map((r) => `${r.fileName}: ${r.error}`);
				setErrors([...skipped, ...failed, ...(res.ok ? [] : [body.error ?? `Upload failed (HTTP ${res.status}).`])]);
			} catch (err) {
				setErrors([...skipped, `Upload failed: ${err instanceof Error ? err.message : String(err)}`]);
			} finally {
				setUploading(false);
				await refresh();
			}
		},
		[refresh],
	);

	const outline = useCallback(
		async (id: string) => {
			try {
				const res = await fetch(`/api/library/${id}/outline`, { method: "POST" });
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as { error?: string };
					setErrors([body.error ?? `The outline could not be started (HTTP ${res.status}).`]);
				} else setErrors([]);
			} finally {
				await refresh();
			}
		},
		[refresh],
	);

	const remove = useCallback(
		async (id: string) => {
			try {
				await fetch(`/api/library/${id}`, { method: "DELETE" });
			} finally {
				await refresh();
			}
		},
		[refresh],
	);

	return { sources, errors, uploading, upload, outline, remove, refresh };
}

// ─── The dialog ──────────────────────────────────────────────────────────────

export function LecturesDialog({
	open,
	onClose,
	pick,
	onPick,
}: {
	open: boolean;
	onClose: () => void;
	pick: LecturePick;
	onPick: (next: LecturePick) => void;
}) {
	const library = useLectureLibrary(open);
	const backdropDismiss = useBackdropDismiss(onClose);

	// Esc closes (claimed — a dialog Esc must not also abort a turn).
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);

	// A removed lecture (or a re-outlined one with new topic ids) must not stay picked.
	const { sources } = library;
	useEffect(() => {
		if (!open || sources.length === 0) return;
		const pruned = prunePick(pick, sources);
		if (JSON.stringify(pruned) !== JSON.stringify(pick)) onPick(pruned);
	}, [open, sources, pick, onPick]);

	if (!open) return null;
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<LecturesBody
				sources={library.sources}
				pick={pick}
				errors={library.errors}
				uploading={library.uploading}
				onUpload={(files) => void library.upload(files)}
				onOutline={(id) => void library.outline(id)}
				onRemove={(id) => void library.remove(id)}
				onPick={onPick}
				onClose={onClose}
			/>
		</div>,
		document.body,
	);
}

/** The dialog's pure body — exported for render pins (the delete-dialog pattern). */
export function LecturesBody({
	sources,
	pick,
	errors,
	uploading,
	onUpload,
	onOutline,
	onRemove,
	onPick,
	onClose,
}: {
	sources: readonly LectureSource[];
	pick: LecturePick;
	errors: readonly string[];
	uploading: boolean;
	onUpload: (files: File[]) => void;
	onOutline: (id: string) => void;
	onRemove: (id: string) => void;
	onPick: (next: LecturePick) => void;
	onClose: () => void;
}) {
	const fileInput = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	const counts = countPick(pick);
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Lectures"
			data-testid="lectures-dialog"
			onClick={(e) => e.stopPropagation()}
			className="flex max-h-[85dvh] w-[44rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold text-foreground">Lectures</h2>
			<p className="mt-1.5 text-sm text-muted-foreground">
				Add your lecture PDFs once. Learnbox outlines each into topics; pick the topics and the depth for this session, and the
				probe measures you against exactly those. The lectures are what there is to learn, not what you already know.
			</p>

			<button
				type="button"
				data-testid="lectures-upload"
				onClick={() => fileInput.current?.click()}
				onDragOver={(e) => {
					e.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={(e) => {
					e.preventDefault();
					setDragging(false);
					onUpload(Array.from(e.dataTransfer.files));
				}}
				disabled={uploading}
				className={cn(
					"mt-4 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-4 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-wait",
					dragging ? "border-foreground/60 bg-accent text-foreground" : "border-border/80",
				)}
			>
				<UploadIcon aria-hidden="true" className="size-3.5" />
				{uploading ? "Adding…" : "Add lecture PDFs — click or drop files here"}
			</button>
			<input
				ref={fileInput}
				type="file"
				accept="application/pdf,.pdf"
				multiple
				hidden
				data-testid="lectures-file-input"
				onChange={(e) => {
					onUpload(Array.from(e.target.files ?? []));
					e.target.value = "";
				}}
			/>
			{errors.map((error, i) => (
				<p key={i} role="alert" className="mt-2 whitespace-pre-wrap break-words text-xs text-red-400">
					{error}
				</p>
			))}

			<div data-testid="lectures-list" className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
				{sources.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">No lectures yet.</p>}
				{sources.map((source) => (
					<LectureRow key={source.id} source={source} pick={pick} onOutline={onOutline} onRemove={onRemove} onPick={onPick} />
				))}
			</div>

			<div className="mt-4 flex items-center gap-3">
				<span data-testid="lectures-count" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
					{counts.topics === 0
						? "Nothing picked: the session starts without lectures."
						: `${counts.topics} ${counts.topics === 1 ? "topic" : "topics"} from ${counts.lectures} ${counts.lectures === 1 ? "lecture" : "lectures"} picked`}
				</span>
				{counts.topics > 0 && (
					<button
						type="button"
						data-testid="lectures-clear"
						onClick={() => onPick({})}
						className="cursor-pointer rounded-md px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						Clear
					</button>
				)}
				<button
					type="button"
					data-testid="lectures-done"
					onClick={onClose}
					className="cursor-pointer rounded-md border border-border bg-background px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:bg-accent"
				>
					Done
				</button>
			</div>
		</div>
	);
}

function LectureRow({
	source,
	pick,
	onOutline,
	onRemove,
	onPick,
}: {
	source: LectureSource;
	pick: LecturePick;
	onOutline: (id: string) => void;
	onRemove: (id: string) => void;
	onPick: (next: LecturePick) => void;
}) {
	const topics = source.outline?.topics ?? [];
	const picked = pick[source.id] ?? {};
	const pickedCount = Object.keys(picked).length;
	const [open, setOpen] = useState(pickedCount > 0);
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [confirmRedo, setConfirmRedo] = useState(false);
	const ready = source.status === "ready" && topics.length > 0;
	const allPicked = ready && topics.every((t) => picked[t.id]);

	return (
		<div data-testid={`lecture-${source.id}`} className="rounded-lg border border-border/70">
			<div className="flex items-center gap-2 px-3 py-2">
				<button
					type="button"
					aria-expanded={open}
					aria-label={open ? "Hide topics" : "Show topics"}
					disabled={!ready}
					onClick={() => setOpen((v) => !v)}
					className="flex size-5 shrink-0 cursor-pointer items-center justify-center text-muted-foreground disabled:cursor-default disabled:opacity-30"
				>
					<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 transition-transform", open && ready && "rotate-90")} />
				</button>
				<FileTextIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm text-foreground" title={source.fileName}>
						{source.title}
					</div>
					<div data-testid={`lecture-status-${source.id}`} className="text-xs text-muted-foreground">
						{statusLine(source, pickedCount)}
					</div>
				</div>
				{ready && (
					<button
						type="button"
						data-testid={`lecture-all-${source.id}`}
						onClick={() => {
							setOpen(true);
							onPick(toggleLecture(pick, source));
						}}
						className="cursor-pointer rounded-md px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						{allPicked ? "None" : "All"}
					</button>
				)}
				{(source.status === "stored" || source.status === "failed") && (
					<button
						type="button"
						data-testid={`lecture-outline-${source.id}`}
						onClick={() => onOutline(source.id)}
						className="cursor-pointer rounded-md border border-border bg-background px-2.5 py-1 font-ui text-xs text-foreground transition-colors hover:bg-accent"
					>
						{source.status === "failed" ? "Try again" : "Create outline"}
					</button>
				)}
				{source.status === "ready" && (
					<button
						type="button"
						data-testid={`lecture-recreate-${source.id}`}
						title="Reads the PDF again with your model and replaces the outline. This clears the topics you picked from this lecture."
						onClick={() => {
							if (!confirmRedo) {
								setConfirmRedo(true);
								return;
							}
							setConfirmRedo(false);
							setOpen(false);
							onPick(clearLecture(pick, source.id));
							onOutline(source.id);
						}}
						onBlur={() => setConfirmRedo(false)}
						className={cn(
							"cursor-pointer rounded-md px-2 py-1 font-ui text-xs transition-colors hover:bg-accent",
							confirmRedo ? "text-foreground" : "text-muted-foreground hover:text-foreground",
						)}
					>
						{confirmRedo ? "Replace outline?" : "Re-create outline"}
					</button>
				)}
				{source.status !== "outlining" && (
					<button
						type="button"
						data-testid={`lecture-remove-${source.id}`}
						onClick={() => {
							if (confirmRemove) onRemove(source.id);
							else setConfirmRemove(true);
						}}
						onBlur={() => setConfirmRemove(false)}
						className={cn(
							"cursor-pointer rounded-md px-2 py-1 font-ui text-xs transition-colors hover:bg-accent",
							confirmRemove ? "text-destructive" : "text-muted-foreground hover:text-foreground",
						)}
					>
						{confirmRemove ? "Remove?" : "Remove"}
					</button>
				)}
			</div>
			{source.error && source.status !== "outlining" && (
				<p role="alert" className="border-t border-border/50 px-4 py-2 text-xs text-red-400">
					{source.error}
				</p>
			)}
			{ready && open && (
				<div className="space-y-px border-t border-border/50 px-2 py-1.5">
					{source.outline?.thinPages && source.outline.thinPages.length > 0 && (
						<p className="px-2 py-1 text-xs text-muted-foreground">
							{source.outline.thinPages.length === 1 ? "Page" : "Pages"} {formatPages(source.outline.thinPages)} had no readable text (images?)
							and are not in the outline.
						</p>
					)}
					{topics.map((topic) => {
						const depth = picked[topic.id];
						return (
							<div key={topic.id} data-testid={`topic-${source.id}-${topic.id}`} className="flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/40">
								<button
									type="button"
									role="checkbox"
									aria-checked={!!depth}
									aria-label={`Pick ${topic.title}`}
									onClick={() => onPick(toggleTopic(pick, source.id, topic.id))}
									className={cn(
										"mt-0.5 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm border transition-colors",
										depth ? "border-foreground bg-foreground text-background" : "border-border bg-transparent",
									)}
								>
									{depth && <CheckIcon aria-hidden="true" className="size-3" />}
								</button>
								<div className="min-w-0 flex-1">
									<div className="text-sm text-foreground">
										{topic.title} <span className="text-xs text-muted-foreground">pp. {topic.pageStart}-{topic.pageEnd}</span>
									</div>
									<div className="text-xs leading-relaxed text-muted-foreground">{topic.summary}</div>
								</div>
								{depth && (
									<div role="radiogroup" aria-label={`Depth for ${topic.title}`} className="flex shrink-0 overflow-hidden rounded-md border border-border/70">
										{LECTURE_DEPTHS.map((d) => (
											<button
												key={d}
												type="button"
												role="radio"
												aria-checked={depth === d}
												data-testid={`depth-${source.id}-${topic.id}-${d}`}
												onClick={() => onPick(setDepth(pick, source.id, topic.id, d))}
												className={cn(
													"cursor-pointer px-2 py-1 font-ui text-[11px] transition-colors",
													depth === d ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground",
												)}
											>
												{DEPTH_LABEL[d]}
											</button>
										))}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

/** "pages 4, 5, 9" for a short list; a count beyond that. */
export function formatPages(pages: readonly number[]): string {
	return pages.length <= 8 ? pages.join(", ") : `${pages.slice(0, 8).join(", ")} and ${pages.length - 8} more`;
}

export function statusLine(source: LectureSource, pickedCount: number): string {
	const pages = source.pages === null ? "" : `${source.pages} ${source.pages === 1 ? "page" : "pages"}`;
	switch (source.status) {
		case "stored":
			return [pages, "no outline yet"].filter(Boolean).join(" · ");
		case "outlining": {
			const p = source.progress;
			const step = p && p.total > 0 ? ` ${p.done}/${p.total}` : "";
			return [pages, `outlining…${step}`].filter(Boolean).join(" · ");
		}
		case "failed":
			return [pages, "outline failed"].filter(Boolean).join(" · ");
		case "ready": {
			const n = source.outline?.topics.length ?? 0;
			return [pages, `${n} ${n === 1 ? "topic" : "topics"}`, pickedCount > 0 ? `${pickedCount} picked` : ""].filter(Boolean).join(" · ");
		}
	}
}
