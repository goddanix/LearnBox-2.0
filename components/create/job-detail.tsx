"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon, CheckIcon, PlusIcon, SquareIcon, Undo2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { studyApi as api, postJson } from "@/components/study/api";
import { MCQ_LETTERS } from "@/src/core";
import type { CreateJobDetail, McqQuestion } from "@/src/core";

const LAST_COURSE_KEY = "lb-create-course";

function remembered(): string {
	try {
		return window.localStorage.getItem(LAST_COURSE_KEY) ?? "";
	} catch {
		return "";
	}
}

/** One job: its pages and drafts, with throw-away, retry, "more questions" and the adoption into a course. */
export function JobDetail({
	jobId,
	courses,
	onBack,
	onChanged,
	onCourseAdded,
}: {
	jobId: string;
	courses: { id: string; name: string }[];
	onBack: () => void;
	/** The job list should reload (a run started or stopped, drafts adopted). */
	onChanged: () => void;
	onCourseAdded: () => void;
}) {
	const [detail, setDetail] = useState<CreateJobDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [skip, setSkip] = useState<Set<string>>(new Set());
	const [courseId, setCourseId] = useState(remembered);
	const [newCourse, setNewCourse] = useState("");
	const [note, setNote] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			setDetail(await api<CreateJobDetail>(`/api/create/jobs/${jobId}`));
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

	const effectiveCourse = courses.some((c) => c.id === courseId) ? courseId : (courses[0]?.id ?? "");

	/** Drafts that can still be adopted: neither thrown away nor already a card. */
	const eligible = useMemo(
		() => (detail?.pages ?? []).flatMap((p) => p.questions).filter((q) => !q.deleted && !q.adopted),
		[detail],
	);
	const chosen = eligible.filter((q) => !skip.has(q.id));

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
	const toggleDeleted = (q: McqQuestion) =>
		act(() => api(`/api/create/jobs/${jobId}/questions/${q.id}`, { ...postJson({ deleted: !q.deleted }), method: "PATCH" }));

	async function adopt() {
		let target = effectiveCourse;
		await act(
			async () => {
				if (newCourse.trim()) {
					const out = await api<{ course: { id: string } }>("/api/study/courses", postJson({ name: newCourse.trim() }));
					target = out.course.id;
					setNewCourse("");
					onCourseAdded();
				}
				if (!target) throw new Error("Choose a course first, or name a new one.");
				const all = chosen.length === eligible.length;
				const out = await api<{ adopted: number }>(
					`/api/create/jobs/${jobId}/adopt`,
					postJson({ courseId: target, ...(all ? {} : { questionIds: chosen.map((q) => q.id) }) }),
				);
				try {
					window.localStorage.setItem(LAST_COURSE_KEY, target);
				} catch {
					/* remembered choice is a convenience only */
				}
				setCourseId(target);
				return out;
			},
			(out) => setNote(`${out.adopted} question${out.adopted === 1 ? "" : "s"} added to your cards.`),
		);
	}

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
		<div className="flex flex-col gap-4" data-testid="job-detail">
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
					<>
						{unfinished && (
							<Button variant="outline" size="sm" disabled={busy} onClick={() => void start({})} data-testid="job-resume">
								Continue
							</Button>
						)}
						<Button variant="outline" size="sm" disabled={busy} onClick={() => void start({ more: true })} data-testid="job-more">
							<PlusIcon /> More questions
						</Button>
					</>
				)}
			</div>

			{(error || job.blocked || job.fatal) && (
				<p className="rounded-md border border-red-500/40 p-3 text-sm text-red-400" role="alert">
					{error ?? job.blocked ?? job.fatal}
				</p>
			)}

			<p className="text-xs text-muted-foreground" data-testid="job-progress">
				{running ? "Working… " : job.state === "done" ? "Finished. " : "Paused. "}
				{job.counts.done} of {job.total} pages · {job.drafts} drafts · {job.adopted} in your cards
				{job.counts.error > 0 && ` · ${job.counts.error} page${job.counts.error === 1 ? "" : "s"} failed`}
			</p>

			<div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3" data-testid="adopt-bar">
				<label className="flex flex-col gap-1 text-xs text-muted-foreground">
					Add to course
					<select
						className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
						value={effectiveCourse}
						onChange={(e) => setCourseId(e.target.value)}
						disabled={newCourse.trim().length > 0}
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
				<label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">
					Or a new course
					<Input value={newCourse} onChange={(e) => setNewCourse(e.target.value)} placeholder="e.g. Anatomy" data-testid="adopt-new-course" />
				</label>
				<Button size="sm" disabled={busy || chosen.length === 0} onClick={() => void adopt()} data-testid="adopt-button">
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
					<details key={p.page} open={detail.pages.length <= 4} className="rounded-lg border" data-testid="job-page">
						<summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
							<span className="font-medium">Page {p.page}</span>
							<span className="text-xs text-muted-foreground">
								{p.status === "done" && `${p.questions.filter((q) => !q.deleted).length} drafts`}
								{p.status === "running" && "working…"}
								{p.status === "pending" && "waiting"}
								{p.status === "error" && <span className="text-red-400">failed — {p.error}</span>}
							</span>
							{p.status === "error" && !running && (
								<Button
									variant="outline"
									size="xs"
									className="ml-auto"
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
							{p.questions.map((q) => (
								<Draft
									key={q.id}
									q={q}
									selected={!skip.has(q.id)}
									onSelect={(on) =>
										setSkip((prev) => {
											const next = new Set(prev);
											if (on) next.delete(q.id);
											else next.add(q.id);
											return next;
										})
									}
									onToggleDeleted={() => void toggleDeleted(q)}
								/>
							))}
							{p.questions.length === 0 && p.status === "done" && (
								<li className="text-xs text-muted-foreground">No testable content on this page.</li>
							)}
						</ul>
					</details>
				))}
			</div>
		</div>
	);
}

function Draft({
	q,
	selected,
	onSelect,
	onToggleDeleted,
}: {
	q: McqQuestion;
	selected: boolean;
	onSelect: (on: boolean) => void;
	onToggleDeleted: () => void;
}) {
	return (
		<li className={`flex items-start gap-2 rounded-md border p-3 ${q.deleted ? "opacity-50" : ""}`} data-testid="draft">
			{q.adopted || q.deleted ? (
				<SquareIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/40" aria-hidden />
			) : (
				<input
					type="checkbox"
					className="mt-1 size-4 shrink-0"
					checked={selected}
					onChange={(e) => onSelect(e.target.checked)}
					aria-label="Add this question to my cards"
				/>
			)}
			<div className="min-w-0 flex-1 text-sm">
				<p className={`whitespace-pre-wrap font-medium ${q.deleted ? "line-through" : ""}`}>{q.question}</p>
				<ul className="mt-1 flex flex-col gap-0.5">
					{MCQ_LETTERS.map((letter) => (
						<li key={letter} className={q.correct.includes(letter) ? "text-emerald-400" : "text-muted-foreground"}>
							<b>{letter}.</b> {q.options[letter]}
						</li>
					))}
				</ul>
				<details className="mt-1 text-xs text-muted-foreground">
					<summary className="cursor-pointer">Explanation</summary>
					<p className="mt-1 whitespace-pre-wrap">{q.explanation}</p>
				</details>
			</div>
			{q.adopted ? (
				<span className="shrink-0 text-xs text-emerald-400">In your cards</span>
			) : (
				<Button variant="ghost" size="icon-xs" onClick={onToggleDeleted} title={q.deleted ? "Bring back" : "Throw away"} aria-label={q.deleted ? "Bring back" : "Throw away"}>
					{q.deleted ? <Undo2Icon /> : <XIcon />}
				</Button>
			)}
		</li>
	);
}
