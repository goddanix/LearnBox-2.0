"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, FileUpIcon, SparklesIcon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { studyApi as api, postJson } from "@/components/study/api";
import { CourseNotes } from "@/components/create/course-notes";
import { CardBody } from "@/components/create/draft-card";
import { DuplicatesPanel } from "@/components/create/duplicates-panel";
import type { AssignStatus, CourseDraft, CourseTag, CreateCourse, CreateJobSummary, TopicProposal, TopicsFromFile } from "@/src/core";

const put = (body: object): RequestInit => ({ ...postJson(body), method: "PUT" });
const jobMedia = (jobId: string) => (file: string) => `/api/create/jobs/${jobId}/media/${encodeURIComponent(file)}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The topics of a course: written by hand, taken from a file, or tidied up by Claude. */
function Topics({ course, onChanged }: { course: CreateCourse; onChanged: (course: CreateCourse) => void }) {
	const [text, setText] = useState(course.topics.join("\n"));
	const [strict, setStrict] = useState(course.strict);
	const [note, setNote] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<"save" | "file" | "tidy" | null>(null);
	const [proposal, setProposal] = useState<TopicProposal | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	const lines = text.split("\n");
	async function save(topics: string[] = lines, only: boolean = strict) {
		setBusy("save");
		setError(null);
		setNote(null);
		try {
			const out = await api<{ course: CreateCourse }>(`/api/create/courses/${course.id}`, put({ topics, strict: only }));
			setText(out.course.topics.join("\n"));
			setStrict(out.course.strict);
			setNote("Saved — PDFs that used the old list as their focus take the new one.");
			onChanged(out.course);
		} catch (e) {
			setError(message(e));
		} finally {
			setBusy(null);
		}
	}

	async function fromFile(file: File | undefined) {
		if (!file) return;
		setBusy("file");
		setError(null);
		setNote(null);
		try {
			const form = new FormData();
			form.append("file", file);
			const out = await api<TopicsFromFile>(`/api/create/courses/${course.id}/topics`, { method: "POST", body: form });
			setText(out.course.topics.join("\n"));
			setStrict(out.course.strict);
			setNote(
				out.matched > 0 || course.topics.length > 0
					? `${out.found} entries in the file: ${out.matched} belong to topics you have, ${out.added.length} new${out.added.length > 0 ? ` (${out.added.join(", ")})` : ""}.`
					: `${out.added.length} topics taken from the file.`,
			);
			onChanged(out.course);
		} catch (e) {
			setError(message(e));
		} finally {
			setBusy(null);
			if (fileInput.current) fileInput.current.value = "";
		}
	}

	async function tidy() {
		setBusy("tidy");
		setError(null);
		setNote(null);
		try {
			setProposal(await api<TopicProposal>(`/api/create/courses/${course.id}/topics/consolidate`, postJson({})));
		} catch (e) {
			setError(message(e));
		} finally {
			setBusy(null);
		}
	}

	return (
		<section className="flex flex-col gap-2 rounded-lg border bg-card p-3" data-testid="course-topics">
			<h3 className="text-sm font-medium">Topics</h3>
			<p className="text-xs text-muted-foreground">One topic per line. The PDFs made for this course look closer at them — or only at them.</p>
			<Textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(12, Math.max(4, lines.length + 1))} placeholder={"Heart failure\nValves\nRhythm disorders"} aria-label="Topics" data-testid="course-topics-text" />
			<label className="flex items-center gap-2 text-sm">
				<input type="checkbox" className="size-4" checked={strict} onChange={(e) => setStrict(e.target.checked)} data-testid="course-topics-strict" />
				Only these topics (PDFs skip pages about anything else)
			</label>
			<div className="flex flex-wrap items-center gap-2">
				<Button size="sm" disabled={busy !== null} onClick={() => void save()} data-testid="course-topics-save">
					Save
				</Button>
				<input ref={fileInput} type="file" accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf" hidden data-testid="course-topics-file" onChange={(e) => void fromFile(e.target.files?.[0])} />
				<Button size="sm" variant="outline" disabled={busy !== null} onClick={() => fileInput.current?.click()} title="A .txt or .md file (a topic per line) or a PDF of goals; with topics set, new entries are matched to them">
					<FileUpIcon /> {busy === "file" ? "Reading…" : "Topics from a file"}
				</Button>
				<Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void tidy()} data-testid="course-topics-tidy" title="Claude sums the list and the lectures up into a few main topics — a proposal, nothing changes until you take it">
					<SparklesIcon /> {busy === "tidy" ? "Thinking…" : "Tidy up with Claude"}
				</Button>
			</div>
			{note && (
				<p className="text-xs text-emerald-400" role="status">
					{note}
				</p>
			)}
			{error && (
				<p className="text-sm text-red-400" role="alert">
					{error}
				</p>
			)}
			{proposal && (
				<div className="flex flex-col gap-2 rounded-md border p-2" data-testid="course-proposal">
					<p className="text-xs text-muted-foreground">Claude suggests these main topics. They would replace your list ({proposal.current.length} topics now).</p>
					<ul className="flex flex-wrap gap-1.5">
						{proposal.topics.map((t) => (
							<li key={t.name} className="rounded-full border px-2 py-0.5 text-xs" title={t.source === "list" ? "from your list" : "found on the lecture pages"}>
								{t.name}
								{t.source === "lecture" && <span className="text-muted-foreground"> · from lectures</span>}
							</li>
						))}
					</ul>
					<div className="flex gap-2">
						<Button
							size="xs"
							disabled={busy !== null}
							onClick={() => {
								const names = proposal.topics.map((t) => t.name);
								setProposal(null);
								void save(names);
							}}
							data-testid="course-proposal-use"
						>
							Use this list
						</Button>
						<Button size="xs" variant="ghost" onClick={() => setProposal(null)}>
							Not now
						</Button>
					</div>
				</div>
			)}
		</section>
	);
}

/** Sorting the drafts of all the course's PDFs into its topics, and looking at them by topic. */
function Sorting({ course, onChanged }: { course: CreateCourse; onChanged: () => void }) {
	const [status, setStatus] = useState<AssignStatus | null>(null);
	const [tags, setTags] = useState<CourseTag[] | null>(null);
	const [shown, setShown] = useState<{ tag: string | null; cards: CourseDraft[] } | null>(null);
	const [error, setError] = useState<string | null>(null);

	const loadTags = useCallback(async () => {
		try {
			setTags((await api<{ tags: CourseTag[] }>(`/api/create/courses/${course.id}/tags`)).tags);
		} catch (e) {
			setError(message(e));
		}
	}, [course.id]);
	const loadStatus = useCallback(async () => {
		try {
			setStatus(await api<AssignStatus>(`/api/create/courses/${course.id}/cards/assign`));
		} catch (e) {
			setError(message(e));
		}
	}, [course.id]);
	useEffect(() => {
		void loadTags();
		void loadStatus();
	}, [loadTags, loadStatus, course.drafts]);

	const running = status?.state === "running";
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => {
			void loadStatus();
		}, 1500);
		return () => clearInterval(timer);
	}, [running, loadStatus]);
	const finished = status?.state === "done";
	const changed = useRef(onChanged);
	useEffect(() => {
		changed.current = onChanged;
	});
	useEffect(() => {
		if (!finished) return;
		void loadTags();
		changed.current();
	}, [finished, loadTags]);

	async function assign() {
		setError(null);
		try {
			await api(`/api/create/courses/${course.id}/cards/assign`, postJson({}));
			await loadStatus();
		} catch (e) {
			setError(message(e));
		}
	}
	async function undo() {
		setError(null);
		try {
			await api(`/api/create/courses/${course.id}/cards/unassign`, postJson({}));
			setShown(null);
			await Promise.all([loadStatus(), loadTags()]);
		} catch (e) {
			setError(message(e));
		}
	}
	async function show(tag: string | null) {
		if (shown && shown.tag === tag) return setShown(null);
		try {
			const url = `/api/create/courses/${course.id}/cards${tag === null ? "" : `?tag=${encodeURIComponent(tag)}`}`;
			setShown({ tag, cards: (await api<{ cards: CourseDraft[] }>(url)).cards });
		} catch (e) {
			setError(message(e));
		}
	}

	const SHOWN_MAX = 100;
	return (
		<section className="flex flex-col gap-2 rounded-lg border bg-card p-3" data-testid="course-sorting">
			<h3 className="text-sm font-medium">Drafts by topic</h3>
			<div className="flex flex-wrap items-center gap-2">
				<Button size="sm" variant="outline" disabled={running || course.topics.length === 0 || course.drafts === 0} onClick={() => void assign()} data-testid="course-assign" title="Claude gives every draft of every PDF of this course the topic it belongs to (replacing its label)">
					<SparklesIcon /> {running ? "Sorting…" : "Sort the drafts into the topics"}
				</Button>
				<Button size="sm" variant="ghost" disabled={running || course.drafts === 0} onClick={() => void undo()} data-testid="course-unassign">
					<Undo2Icon /> Undo sorting
				</Button>
				{course.topics.length === 0 && <span className="text-xs text-muted-foreground">Set the topics first.</span>}
				{running && status && (
					<span className="text-xs text-muted-foreground" role="status">
						{status.done} of {status.total} drafts…
					</span>
				)}
				{status?.state === "done" && status.result && (
					<span className="text-xs text-emerald-400" role="status" data-testid="course-assign-result">
						Sorted {status.result.assigned} draft{status.result.assigned === 1 ? "" : "s"}
						{status.result.other > 0 && `, ${status.result.other} fit none (“Other”)`}
						{status.result.skipped > 0 && `; ${status.result.skipped} left as they were (already in your cards, or still being made)`}.
					</span>
				)}
				{status?.state === "error" && (
					<span className="text-xs text-red-400" role="alert">
						{status.error}
					</span>
				)}
			</div>
			{error && (
				<p className="text-sm text-red-400" role="alert">
					{error}
				</p>
			)}
			{tags?.length === 0 && <p className="text-sm text-muted-foreground">No drafts with labels yet.</p>}
			{tags && tags.length > 0 && (
				<ul className="flex flex-wrap gap-1.5" data-testid="course-tags">
					{tags.map((t) => (
						<li key={t.tag}>
							<button
								type="button"
								onClick={() => void show(t.tag)}
								aria-pressed={shown?.tag === t.tag}
								className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent ${shown?.tag === t.tag ? "border-sky-400/70 bg-sky-400/10" : ""}`}
							>
								{t.tag} <span className="text-muted-foreground">{t.selected === t.total ? t.total : `${t.selected}/${t.total}`}</span>
							</button>
						</li>
					))}
				</ul>
			)}
			{shown && (
				<ul className="flex flex-col gap-2" data-testid="course-cards">
					{shown.cards.slice(0, SHOWN_MAX).map((d) => (
						<li key={`${d.jobId}|${d.card.id}`} className="rounded-md border p-2 text-sm">
							<p className="mb-0.5 text-xs text-muted-foreground">
								{d.jobName} · page {d.card.page}
							</p>
							<CardBody c={d.card} mediaUrl={jobMedia(d.jobId)} />
						</li>
					))}
					{shown.cards.length === 0 && <li className="text-sm text-muted-foreground">Nothing here.</li>}
					{shown.cards.length > SHOWN_MAX && <li className="text-xs text-muted-foreground">Showing the first {SHOWN_MAX} of {shown.cards.length}. Open a PDF to see all of its cards.</li>}
				</ul>
			)}
		</section>
	);
}

/** One course: its name, topics, the drafts by topic, the PDFs made for it, and duplicates across them. */
export function CourseDetail({
	courseId,
	jobs,
	onBack,
	onOpenJob,
	onChanged,
}: {
	courseId: string;
	/** Every Create job; the course shows its own PDFs. */
	jobs: CreateJobSummary[];
	onBack: () => void;
	onOpenJob: (job: CreateJobSummary) => void;
	/** The course list should reload (topics, name or drafts changed). */
	onChanged: () => void;
}) {
	const [course, setCourse] = useState<CreateCourse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showDuplicates, setShowDuplicates] = useState(false);
	const [name, setName] = useState("");
	const [renaming, setRenaming] = useState(false);

	const load = useCallback(async () => {
		try {
			const out = await api<{ course: CreateCourse }>(`/api/create/courses/${courseId}`);
			setCourse(out.course);
			setName((n) => (n === "" ? out.course.name : n));
			setError(null);
		} catch (e) {
			setError(message(e));
		}
	}, [courseId]);
	useEffect(() => {
		void load();
	}, [load]);

	async function rename() {
		try {
			const out = await api<{ course: CreateCourse }>(`/api/create/courses/${courseId}`, put({ name }));
			setCourse(out.course);
			setName(out.course.name);
			setRenaming(false);
			setError(null);
			onChanged();
		} catch (e) {
			setError(message(e));
		}
	}

	const mine = jobs.filter((j) => j.kind === "cards" && j.courseId === courseId);
	return (
		<div className="flex flex-col gap-4" data-testid="course-detail">
			<div className="flex items-center gap-2">
				<Button variant="ghost" size="sm" onClick={onBack}>
					<ArrowLeftIcon /> Back
				</Button>
				{renaming ? (
					<form
						className="flex min-w-0 flex-1 items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							void rename();
						}}
					>
						<Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Course name" autoFocus />
						<Button type="submit" size="sm">
							Save
						</Button>
					</form>
				) : (
					<>
						<h2 className="min-w-0 flex-1 truncate text-base">{course?.name ?? "…"}</h2>
						{course && (
							<Button variant="ghost" size="xs" onClick={() => setRenaming(true)}>
								Rename
							</Button>
						)}
					</>
				)}
			</div>
			{error && (
				<p className="rounded-md border border-red-500/40 p-3 text-sm text-red-400" role="alert">
					{error}
				</p>
			)}
			{course && (
				<>
					<Topics
						course={course}
						onChanged={(c) => {
							setCourse(c);
							onChanged();
						}}
					/>
					<Sorting
						course={course}
						onChanged={() => {
							void load();
							onChanged();
						}}
					/>
					<CourseNotes course={course} />
					<section className="flex flex-col gap-1.5" data-testid="course-jobs">
						<h3 className="text-sm font-medium">PDFs of this course</h3>
						{mine.length === 0 && <p className="text-sm text-muted-foreground">None yet. Make flashcards from a PDF and choose this course — or put an existing one here from its page.</p>}
						{mine.map((j) => (
							<button key={j.id} type="button" data-testid="course-job" onClick={() => onOpenJob(j)} className="flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-accent">
								<span className="truncate">{j.name}</span>
								<span className="text-xs text-muted-foreground">
									{j.counts.done} of {j.total} pages · {j.drafts} drafts · {j.adopted} in your cards
								</span>
							</button>
						))}
					</section>
					<div>
						<Button variant="outline" size="sm" onClick={() => setShowDuplicates((v) => !v)} disabled={mine.length === 0} data-testid="course-dup-toggle">
							{showDuplicates ? "Hide duplicates" : "Look for duplicates across the PDFs"}
						</Button>
					</div>
					{showDuplicates && (
						<DuplicatesPanel
							scope={{ courseId }}
							onChanged={() => {
								void load();
								onChanged();
							}}
						/>
					)}
				</>
			)}
		</div>
	);
}
