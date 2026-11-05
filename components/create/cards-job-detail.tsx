"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon, CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { studyApi as api, postJson } from "@/components/study/api";
import { CardsFocus } from "@/components/create/cards-focus";
import { DuplicatesPanel } from "@/components/create/duplicates-panel";
import type { CardsJobDetail } from "@/src/core";

const LAST_COURSE_KEY = "lb-create-course";

function remembered(): string {
	try {
		return window.localStorage.getItem(LAST_COURSE_KEY) ?? "";
	} catch {
		return "";
	}
}

const patch = (body: object): RequestInit => ({ ...postJson(body), method: "PATCH" });
const put = (body: object): RequestInit => ({ ...postJson(body), method: "PUT" });

/** The topics the cards favour (or are limited to) — they count for the pages processed from now on. */
function FocusTopics({ jobId, topics, strict, onSaved }: { jobId: string; topics: string[]; strict: boolean; onSaved: () => void }) {
	const [text, setText] = useState(topics.join(", "));
	const [only, setOnly] = useState(strict);
	const [note, setNote] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function save() {
		setBusy(true);
		setNote(null);
		try {
			const out = await api<{ focusTopics: string[] }>(`/api/create/jobs/${jobId}/focus`, patch({ focusTopics: text, focusStrict: only }));
			setText(out.focusTopics.join(", "));
			setNote("Saved — it counts for the pages that are processed from now on.");
			onSaved();
		} catch (e) {
			setNote(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<details className="rounded-lg border" data-testid="focus-topics">
			<summary className="cursor-pointer px-3 py-2 text-sm">
				Focus topics <span className="text-xs text-muted-foreground">{topics.length > 0 ? `· ${topics.join(", ")}${strict ? " (only these)" : ""}` : "· none"}</span>
			</summary>
			<div className="flex flex-col gap-2 p-3 pt-0">
				<Input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. heart failure, troponin" aria-label="Focus topics" />
				<label className="flex items-center gap-2 text-sm">
					<input type="checkbox" className="size-4" checked={only} onChange={(e) => setOnly(e.target.checked)} />
					Only these topics (skip pages about anything else)
				</label>
				<div className="flex items-center gap-2">
					<Button size="xs" disabled={busy} onClick={() => void save()}>
						Save
					</Button>
					{note && <span className="text-xs text-muted-foreground">{note}</span>}
				</div>
			</div>
		</details>
	);
}

/** One job of flashcards: its pages (open one in the focus screen), the choice of cards, duplicates, and the adoption into a course. */
export function CardsJobDetail({
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
	const [detail, setDetail] = useState<CardsJobDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [courseId, setCourseId] = useState("");
	const [newCourse, setNewCourse] = useState("");
	const [note, setNote] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [focusPage, setFocusPage] = useState<number | null>(null);
	const [showDuplicates, setShowDuplicates] = useState(false);

	const load = useCallback(async () => {
		try {
			setDetail(await api<CardsJobDetail>(`/api/create/jobs/${jobId}`));
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

	// the course picked here, else the course the PDF belongs to, else the one used last
	const known = (id: string | undefined) => (id !== undefined && courses.some((c) => c.id === id) ? id : "");
	const effectiveCourse = known(courseId) || known(detail?.job.courseId) || known(remembered()) || (courses[0]?.id ?? "");

	/** Drafts that can still be adopted: neither thrown away nor already a card — and of those, the selected ones. */
	const eligible = useMemo(() => (detail?.pages ?? []).flatMap((p) => p.cards).filter((c) => !c.deleted && !c.adopted), [detail]);
	const chosen = eligible.filter((c) => c.include);

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
	const reload = useCallback(async () => {
		await load();
		onChanged();
	}, [load, onChanged]);
	const setCourseOfPdf = (id: string) => act(() => api(`/api/create/jobs/${jobId}/course`, put({ courseId: id || null })));
	const selectAll = (include: boolean) => act(() => api(`/api/create/jobs/${jobId}/include`, postJson({ cardIds: eligible.map((c) => c.id), include })));

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
				const out = await api<{ adopted: number }>(`/api/create/jobs/${jobId}/adopt`, postJson({ courseId: target }));
				try {
					window.localStorage.setItem(LAST_COURSE_KEY, target);
				} catch {
					/* remembered choice is a convenience only */
				}
				setCourseId(target);
				return out;
			},
			(out) => setNote(`${out.adopted} draft${out.adopted === 1 ? "" : "s"} added to your cards.`),
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
	const mediaUrl = (file: string) => `/api/create/jobs/${jobId}/media/${encodeURIComponent(file)}`;
	return (
		<div className="flex flex-col gap-4" data-testid="cards-job-detail">
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
				{job.counts.done} of {job.total} pages · {job.drafts} drafts · {job.adopted} in your cards
				{job.counts.error > 0 && ` · ${job.counts.error} page${job.counts.error === 1 ? "" : "s"} failed`}
			</p>

			<label className="flex flex-wrap items-center gap-2 text-sm" data-testid="job-course">
				<span className="text-xs text-muted-foreground">This PDF belongs to the course</span>
				<select
					className="h-8 rounded-md border bg-background px-2 text-sm"
					value={known(job.courseId)}
					disabled={busy}
					onChange={(e) => void setCourseOfPdf(e.target.value)}
					aria-label="Course of this PDF"
					data-testid="job-course-select"
				>
					<option value="">None</option>
					{courses.map((c) => (
						<option key={c.id} value={c.id}>
							{c.name}
						</option>
					))}
				</select>
				<span className="text-xs text-muted-foreground">Its topics are the focus of the pages made from now on.</span>
			</label>

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
				<div className="flex w-full items-center gap-2 text-xs text-muted-foreground">
					{eligible.length - chosen.length > 0 ? `${eligible.length - chosen.length} of ${eligible.length} not selected.` : `All ${eligible.length} selected.`}
					<Button variant="ghost" size="xs" disabled={busy || eligible.length === 0} onClick={() => void selectAll(true)}>
						Select all
					</Button>
					<Button variant="ghost" size="xs" disabled={busy || eligible.length === 0} onClick={() => void selectAll(false)}>
						Select none
					</Button>
					{note && (
						<span className="text-emerald-400" role="status" data-testid="adopt-note">
							{note}
						</span>
					)}
				</div>
			</div>

			{focusPage !== null ? (
				<CardsFocus jobId={jobId} detail={detail} page={focusPage} onPage={setFocusPage} onClose={() => setFocusPage(null)} onReload={reload} onStart={start} />
			) : (
				<>
					<FocusTopics key={`${detail.settings.focusTopics.join("|")}-${detail.settings.focusStrict}`} jobId={jobId} topics={detail.settings.focusTopics} strict={detail.settings.focusStrict} onSaved={() => void load()} />
					<div>
						<Button variant="outline" size="sm" onClick={() => setShowDuplicates((v) => !v)} data-testid="dup-toggle">
							{showDuplicates ? "Hide duplicates" : "Look for duplicates"}
						</Button>
					</div>
					{showDuplicates && <DuplicatesPanel scope={{ jobId }} onChanged={() => void reload()} />}

					<ul className="flex flex-col gap-1.5" data-testid="job-pages">
						{detail.pages.map((p) => {
							const live = p.cards.filter((c) => !c.deleted);
							const picked = live.filter((c) => c.include && !c.adopted).length;
							return (
								<li key={p.page} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm" data-testid="job-page">
									<span className="w-16 shrink-0 font-medium">Page {p.page}</span>
									<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
										{p.topic}
										{p.status === "done" && !p.skipped && ` · ${live.length} cards, ${picked} selected`}
										{p.status === "done" && p.skipped && " · skipped"}
										{p.status === "running" && " · working…"}
										{p.status === "pending" && " · waiting"}
										{p.status === "error" && <span className="text-red-400"> · failed — {p.error}</span>}
									</span>
									{!running && (p.status === "error" || p.status === "done") && (
										<Button variant="ghost" size="xs" onClick={() => void start({ pages: [p.page] })}>
											{p.status === "error" ? "Try again" : "Run again"}
										</Button>
									)}
									<Button variant="outline" size="xs" onClick={() => setFocusPage(p.page)} data-testid="page-open">
										Open
									</Button>
								</li>
							);
						})}
					</ul>
				</>
			)}
		</div>
	);
}
