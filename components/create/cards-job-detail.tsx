"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon, CheckIcon, SquareIcon, Undo2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { studyApi as api, postJson } from "@/components/study/api";
import type { CardDraft, CardsJobDetail, StudyCourseSummary } from "@/src/core";

const LAST_COURSE_KEY = "lb-create-course";

function remembered(): string {
	try {
		return window.localStorage.getItem(LAST_COURSE_KEY) ?? "";
	} catch {
		return "";
	}
}

const TYPE_LABEL: Record<CardDraft["type"], string> = {
	basic: "Question",
	basic_reversed: "Both directions",
	process: "Process",
	cloze: "Gap text",
	image_occlusion: "Picture",
};

const TIER_LABEL = { 1: "Core", 2: "Good to know", 3: "Detail" } as const;

/** Card text: **bold** and the English addition of a Latin term, as plain React (nothing is injected as HTML). */
function Rich({ text }: { text: string }) {
	return (
		<>
			{text.split(/(\*\*[\s\S]+?\*\*|\[\[en:[\s\S]*?\]\])/g).map((part, i) =>
				part.startsWith("**") ? (
					<b key={i}>{part.slice(2, -2)}</b>
				) : part.startsWith("[[en:") ? (
					<span key={i} className="italic text-muted-foreground">
						{" "}
						({part.slice(5, -2)})
					</span>
				) : (
					<Fragment key={i}>{part}</Fragment>
				),
			)}
		</>
	);
}

/** A gap text with its gaps marked: {{c1::answer}} → the answer in colour. */
function Gaps({ text }: { text: string }) {
	const parts = text.split(/(\{\{c\d+::[\s\S]*?\}\})/g);
	return (
		<>
			{parts.map((part, i) => {
				const m = /^\{\{c(\d+)::([\s\S]*?)(?:::[\s\S]*)?\}\}$/.exec(part);
				return m ? (
					<span key={i} className="rounded bg-sky-400/15 px-1 text-sky-300" title={`Gap ${m[1]}`}>
						<Rich text={m[2]!} />
					</span>
				) : (
					<Rich key={i} text={part} />
				);
			})}
		</>
	);
}

/** A rendered card picture (a local file of the job, so Next's image optimiser has nothing to do). */
function Picture({ src, alt, className }: { src: string; alt: string; className: string }) {
	// eslint-disable-next-line @next/next/no-img-element
	return <img src={src} alt={alt} className={`${className} rounded border`} loading="lazy" />;
}

/** One job of flashcards: its pages and draft cards, with throw-away, run-again and the adoption into a course. */
export function CardsJobDetail({
	jobId,
	courses,
	onBack,
	onChanged,
	onCourseAdded,
}: {
	jobId: string;
	courses: StudyCourseSummary[];
	onBack: () => void;
	/** The job list should reload (a run started or stopped, drafts adopted). */
	onChanged: () => void;
	onCourseAdded: () => void;
}) {
	const [detail, setDetail] = useState<CardsJobDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [skip, setSkip] = useState<Set<string>>(new Set());
	const [courseId, setCourseId] = useState(remembered);
	const [newCourse, setNewCourse] = useState("");
	const [note, setNote] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

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

	const effectiveCourse = courses.some((c) => c.id === courseId) ? courseId : (courses[0]?.id ?? "");

	/** Drafts that can still be adopted: neither thrown away nor already a card. */
	const eligible = useMemo(() => (detail?.pages ?? []).flatMap((p) => p.cards).filter((c) => !c.deleted && !c.adopted), [detail]);
	const chosen = eligible.filter((c) => !skip.has(c.id));

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
	const toggleDeleted = (c: CardDraft) =>
		act(() => api(`/api/create/jobs/${jobId}/cards/${c.id}`, { ...postJson({ deleted: !c.deleted }), method: "PATCH" }));

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
					postJson({ courseId: target, ...(all ? {} : { cardIds: chosen.map((c) => c.id) }) }),
				);
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
							{p.topic && <span className="min-w-0 truncate text-xs text-muted-foreground">{p.topic}</span>}
							<span className="text-xs text-muted-foreground">
								{p.status === "done" && !p.skipped && `${p.cards.filter((c) => !c.deleted).length} cards`}
								{p.status === "done" && p.skipped && "skipped"}
								{p.status === "running" && "working…"}
								{p.status === "pending" && "waiting"}
								{p.status === "error" && <span className="text-red-400">failed — {p.error}</span>}
							</span>
							{!running && (p.status === "error" || p.status === "done") && (
								<Button
									variant="outline"
									size="xs"
									className="ml-auto"
									onClick={(e) => {
										e.preventDefault();
										void start({ pages: [p.page] });
									}}
								>
									{p.status === "error" ? "Try again" : "Run again"}
								</Button>
							)}
						</summary>
						<ul className="flex flex-col gap-2 px-3 pb-3">
							{p.cards.map((c) => (
								<DraftCard
									key={c.id}
									c={c}
									mediaUrl={mediaUrl}
									selected={!skip.has(c.id)}
									onSelect={(on) =>
										setSkip((prev) => {
											const next = new Set(prev);
											if (on) next.delete(c.id);
											else next.add(c.id);
											return next;
										})
									}
									onToggleDeleted={() => void toggleDeleted(c)}
								/>
							))}
							{p.status === "done" && p.skipped && <li className="text-xs text-muted-foreground">Skipped: {p.skipReason || "nothing to learn on this page"}.</li>}
							{p.status === "done" && !p.skipped && p.cards.length === 0 && <li className="text-xs text-muted-foreground">No cards on this page.</li>}
							{p.dropped > 0 && (
								<li className="text-xs text-muted-foreground">
									{p.dropped} card{p.dropped === 1 ? "" : "s"} of the model {p.dropped === 1 ? "was" : "were"} left out (not usable).
								</li>
							)}
						</ul>
					</details>
				))}
			</div>
		</div>
	);
}

export function DraftCard({
	c,
	mediaUrl,
	selected,
	onSelect,
	onToggleDeleted,
}: {
	c: CardDraft;
	mediaUrl: (file: string) => string;
	selected: boolean;
	onSelect: (on: boolean) => void;
	onToggleDeleted: () => void;
}) {
	const picture = c.image?.file ? mediaUrl(c.image.file) : null;
	return (
		<li className={`flex items-start gap-2 rounded-md border p-3 ${c.deleted ? "opacity-50" : ""}`} data-testid="draft">
			{c.adopted || c.deleted ? (
				<SquareIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/40" aria-hidden />
			) : (
				<input
					type="checkbox"
					className="mt-1 size-4 shrink-0"
					checked={selected}
					onChange={(e) => onSelect(e.target.checked)}
					aria-label="Add this card to my cards"
				/>
			)}
			<div className="min-w-0 flex-1 text-sm">
				<p className="mb-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
					<span>{TYPE_LABEL[c.type]}</span>
					<span>{TIER_LABEL[c.tier]}</span>
					{c.manual && <span>Made by you</span>}
				</p>
				{c.type === "image_occlusion" ? (
					<>
						<p className={`font-medium ${c.deleted ? "line-through" : ""}`}>{c.header}</p>
						<p className="text-emerald-400">
							<Rich text={c.label} />
						</p>
						<div className="mt-1 flex flex-wrap gap-2">
							{c.questionFile && <Picture src={mediaUrl(c.questionFile)} alt="Question picture" className="max-h-48" />}
							{c.answerFile && <Picture src={mediaUrl(c.answerFile)} alt="Answer picture" className="max-h-48" />}
						</div>
						{c.needsCheck && <p className="mt-1 text-xs text-amber-400">The covered place is a guess — please look at the picture.</p>}
					</>
				) : c.type === "cloze" ? (
					<>
						<p className={`whitespace-pre-wrap ${c.deleted ? "line-through" : ""}`}>
							<Gaps text={c.text} />
						</p>
						{picture && <Picture src={picture} alt="Figure" className="mt-1 max-h-56" />}
					</>
				) : (
					<>
						{picture && c.image?.where === "front" && <Picture src={picture} alt="Figure" className="mb-1 max-h-48" />}
						<p className={`whitespace-pre-wrap font-medium ${c.deleted ? "line-through" : ""}`}>
							<Rich text={c.front} />
						</p>
						<p className="mt-0.5 whitespace-pre-wrap text-emerald-400">
							<Rich text={c.back} />
						</p>
						{picture && c.image?.where === "extra" && <Picture src={picture} alt="Figure" className="mt-1 max-h-48" />}
					</>
				)}
				{c.extra && (
					<p className="mt-1 whitespace-pre-wrap border-l-2 pl-2 text-xs text-muted-foreground">
						<Rich text={c.extra} />
					</p>
				)}
				{c.warnings.length > 0 && !c.deleted && <p className="mt-1 text-xs text-amber-400">{c.warnings.join(" · ")}</p>}
				{c.note && <p className="mt-1 text-xs italic text-muted-foreground">{c.note}</p>}
			</div>
			{c.adopted ? (
				<span className="shrink-0 text-xs text-emerald-400">In your cards</span>
			) : (
				<Button variant="ghost" size="icon-xs" onClick={onToggleDeleted} title={c.deleted ? "Bring back" : "Throw away"} aria-label={c.deleted ? "Bring back" : "Throw away"}>
					{c.deleted ? <Undo2Icon /> : <XIcon />}
				</Button>
			)}
		</li>
	);
}
