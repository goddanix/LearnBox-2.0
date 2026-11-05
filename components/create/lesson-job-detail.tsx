"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon, CheckIcon, PencilIcon, SquareIcon, Undo2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { studyApi as api, postJson } from "@/components/study/api";
import type { LessonDraft, LessonJobDetail as Detail } from "@/src/core";

const textarea = "w-full rounded-md border bg-background px-2 py-1 text-sm text-foreground";

/** One lesson-cards job: its statements with the draft cards made for each — check, edit or throw away — and the adoption into a course (always as core knowledge). */
export function LessonJobDetail({
	jobId,
	courses,
	onBack,
	onChanged,
}: {
	jobId: string;
	courses: { id: string; name: string }[];
	onBack: () => void;
	/** The job list should reload (a run started or stopped, drafts adopted). */
	onChanged: () => void;
	onCourseAdded?: () => void;
}) {
	const [detail, setDetail] = useState<Detail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [courseId, setCourseId] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			setDetail(await api<Detail>(`/api/create/jobs/${jobId}`));
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [jobId]);

	const running = detail?.job.running ?? false;
	useEffect(() => {
		void load();
	}, [load]);
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => void load(), 2000);
		return () => clearInterval(timer);
	}, [running, load]);

	// The job's course unless the learner chose another; a course that is gone falls back to the first.
	const wanted = courseId ?? detail?.job.courseId ?? "";
	const effectiveCourse = courses.some((c) => c.id === wanted) ? wanted : (courses[0]?.id ?? "");

	/** Drafts that would be adopted now: selected, neither thrown away nor already a card. */
	const chosen = useMemo(() => (detail?.pages ?? []).flatMap((p) => p.cards).filter((c) => c.include && !c.deleted && !c.adopted), [detail]);

	async function act<T>(run: () => Promise<T>, then?: (out: T) => void) {
		setBusy(true);
		setNote(null);
		try {
			const out = await run();
			then?.(out);
			await load();
			onChanged();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	const start = (body: object) => act(() => api(`/api/create/jobs/${jobId}/start`, postJson(body)));
	const stop = () => act(() => api(`/api/create/jobs/${jobId}/stop`, postJson({})));
	const patch = (card: LessonDraft, body: object) => act(() => api(`/api/create/jobs/${jobId}/cards/${card.id}`, { ...postJson(body), method: "PATCH" }));
	const adopt = () =>
		act(
			() => api<{ adopted: number }>(`/api/create/jobs/${jobId}/adopt`, postJson({ courseId: effectiveCourse, cardIds: chosen.map((c) => c.id) })),
			(out) => setNote(`${out.adopted} card${out.adopted === 1 ? "" : "s"} added to your core knowledge.`),
		);

	if (!detail) {
		return (
			<div className="flex flex-col gap-3">
				<Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
					<ArrowLeftIcon /> Back
				</Button>
				{error ? (
					<p className="text-sm text-red-400" role="alert">
						{error}
					</p>
				) : (
					<p className="text-sm text-muted-foreground">Loading…</p>
				)}
			</div>
		);
	}

	const { job } = detail;
	const unfinished = job.counts.pending + job.counts.running > 0;
	return (
		<div className="flex flex-col gap-4" data-testid="lesson-job-detail">
			<div className="flex items-center gap-2">
				<Button variant="ghost" size="sm" onClick={onBack}>
					<ArrowLeftIcon /> Back
				</Button>
				<h2 className="min-w-0 flex-1 truncate text-base">{job.name}</h2>
				{running ? (
					<Button variant="outline" size="sm" disabled={busy} onClick={() => void stop()} data-testid="job-stop">
						Stop
					</Button>
				) : (
					unfinished && (
						<Button variant="outline" size="sm" disabled={busy} onClick={() => void start({})} data-testid="job-resume">
							Continue
						</Button>
					)
				)}
			</div>

			{(error || job.blocked || job.fatal) && (
				<p className="rounded-md border border-red-500/40 p-3 text-sm text-red-400" role="alert">
					{error ?? job.blocked ?? job.fatal}
				</p>
			)}

			<p className="text-xs text-muted-foreground" data-testid="job-progress">
				{running ? "Working… " : job.state === "done" ? "Finished. " : "Paused. "}
				{job.counts.done} of {job.total} statements · {job.drafts} drafts · {job.adopted} in your cards
				{job.counts.error > 0 && ` · ${job.counts.error} failed`}
			</p>

			<div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3" data-testid="adopt-bar">
				<label className="flex flex-col gap-1 text-xs text-muted-foreground">
					Add to course (as core knowledge)
					<select
						className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
						value={effectiveCourse}
						onChange={(e) => setCourseId(e.target.value)}
						data-testid="adopt-course"
					>
						{courses.length === 0 && <option value="">No course yet</option>}
						{courses.map((c) => (
							<option key={c.id} value={c.id}>
								{c.name}
							</option>
						))}
					</select>
				</label>
				<Button size="sm" disabled={busy || chosen.length === 0 || !effectiveCourse} onClick={() => void adopt()} data-testid="adopt-button">
					<CheckIcon /> Add {chosen.length} to my cards
				</Button>
				{note && (
					<p className="w-full text-xs text-emerald-400" role="status" data-testid="adopt-note">
						{note}
					</p>
				)}
			</div>

			<div className="flex flex-col gap-2">
				{detail.pages.map((p) => (
					<details key={p.page} open={detail.pages.length <= 4} className="rounded-lg border" data-testid="lesson-page">
						<summary className="flex cursor-pointer items-start gap-2 px-3 py-2 text-sm">
							<span className="min-w-0 flex-1">
								<span className="block text-xs text-muted-foreground">
									{p.statement.name}
									<span className="ml-2">
										{p.status === "done" && `${p.cards.filter((c) => !c.deleted).length} drafts`}
										{p.status === "running" && "working…"}
										{p.status === "pending" && "waiting"}
										{p.status === "error" && <span className="text-red-400">failed — {p.error}</span>}
									</span>
								</span>
								<span className="block">{p.statement.statement}</span>
							</span>
							{p.status === "error" && !running && (
								<Button
									variant="outline"
									size="xs"
									onClick={(e) => {
										e.preventDefault();
										void start({ pages: [p.page] });
									}}
								>
									Try again
								</Button>
							)}
						</summary>
						<ul className="flex flex-col gap-2 px-3 pb-3">
							{p.cards.map((c) => (
								<Draft key={c.id} card={c} busy={busy || p.status === "running"} onPatch={(body) => patch(c, body)} />
							))}
							{p.cards.length === 0 && p.status === "done" && (
								<li className="text-xs text-muted-foreground" data-testid="lesson-no-cards">
									{p.note || "No card was made from this statement."}
								</li>
							)}
						</ul>
					</details>
				))}
			</div>
		</div>
	);
}

function Draft({ card, busy, onPatch }: { card: LessonDraft; busy: boolean; onPatch: (body: object) => Promise<void> }) {
	const [editing, setEditing] = useState(false);
	const [texts, setTexts] = useState<Record<string, string>>({});
	const fields = card.type === "cloze" ? (["text", "extra"] as const) : (["front", "back", "extra"] as const);
	const value = (key: string) => texts[key] ?? (card as unknown as Record<string, string>)[key] ?? "";
	const label: Record<string, string> = { front: "Question", back: "Answer", text: "Text with gaps {{c1::…}}", extra: "Extra (optional)" };

	async function save() {
		await onPatch(Object.fromEntries(fields.map((k) => [k, value(k)])));
		setEditing(false);
		setTexts({});
	}

	if (editing) {
		return (
			<li className="flex flex-col gap-2 rounded-md border p-3" data-testid="lesson-draft-edit">
				{fields.map((key) => (
					<label key={key} className="flex flex-col gap-1 text-xs text-muted-foreground">
						{label[key]}
						<textarea
							className={textarea}
							rows={key === "extra" ? 1 : 2}
							value={value(key)}
							onChange={(e) => setTexts((prev) => ({ ...prev, [key]: e.target.value }))}
							data-testid={`lesson-edit-${key}`}
						/>
					</label>
				))}
				<div className="flex gap-2">
					<Button size="xs" disabled={busy} onClick={() => void save()} data-testid="lesson-edit-save">
						Save
					</Button>
					<Button
						variant="ghost"
						size="xs"
						onClick={() => {
							setEditing(false);
							setTexts({});
						}}
					>
						Cancel
					</Button>
				</div>
			</li>
		);
	}

	return (
		<li className={`flex items-start gap-2 rounded-md border p-3 ${card.deleted ? "opacity-50" : ""}`} data-testid="lesson-draft">
			{card.adopted || card.deleted ? (
				<SquareIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/40" aria-hidden />
			) : (
				<input
					type="checkbox"
					className="mt-1 size-4 shrink-0"
					checked={card.include}
					disabled={busy}
					onChange={(e) => void onPatch({ include: e.target.checked })}
					aria-label="Add this card to my cards"
				/>
			)}
			<div className={`min-w-0 flex-1 text-sm ${card.deleted ? "line-through" : ""}`}>
				{card.type === "cloze" ? (
					<p className="whitespace-pre-wrap">{card.text}</p>
				) : (
					<>
						<p className="whitespace-pre-wrap font-medium">{card.front}</p>
						<p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{card.back}</p>
					</>
				)}
				{card.extra && <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground/80">{card.extra}</p>}
			</div>
			{card.adopted ? (
				<span className="shrink-0 text-xs text-emerald-400">In your cards</span>
			) : (
				<span className="flex shrink-0 gap-0.5">
					{!card.deleted && (
						<Button variant="ghost" size="icon-xs" disabled={busy} onClick={() => setEditing(true)} title="Edit" aria-label="Edit">
							<PencilIcon />
						</Button>
					)}
					<Button
						variant="ghost"
						size="icon-xs"
						disabled={busy}
						onClick={() => void onPatch({ deleted: !card.deleted })}
						title={card.deleted ? "Bring back" : "Throw away"}
						aria-label={card.deleted ? "Bring back" : "Throw away"}
					>
						{card.deleted ? <Undo2Icon /> : <XIcon />}
					</Button>
				</span>
			)}
		</li>
	);
}
