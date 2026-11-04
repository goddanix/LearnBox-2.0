"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileUpIcon, SparklesIcon } from "lucide-react";
import { CardsJobDetail } from "@/components/create/cards-job-detail";
import { JobDetail } from "@/components/create/job-detail";
import { LegacyImport } from "@/components/create/legacy-import";
import { NewCardsForm } from "@/components/create/new-cards-form";
import { NewJobForm } from "@/components/create/new-job-form";
import { SidebarToggle } from "@/components/sidebar";
import { studyApi as api } from "@/components/study/api";
import { Button } from "@/components/ui/button";
import type { CreateJobSummary, LectureSource, StudyCourseSummary } from "@/src/core";

/**
 * The Create area: the PDF library (the same one the lecture picker uses), the
 * jobs that turn a PDF into draft flashcards or multiple-choice questions, and
 * one job's drafts to adopt into a course. The server holds the runs; this page only polls their progress.
 */

const KIND_LABEL: Record<CreateJobSummary["kind"], string> = {
	mcq: "Multiple-choice test",
	cards: "Flashcards",
};

const STATE_LABEL: Record<CreateJobSummary["state"], string> = {
	queued: "Waiting",
	running: "Working",
	done: "Finished",
	stopped: "Paused",
	interrupted: "Interrupted",
};

export function CreateView() {
	const [lectures, setLectures] = useState<LectureSource[] | null>(null);
	const [jobs, setJobs] = useState<CreateJobSummary[] | null>(null);
	const [courses, setCourses] = useState<StudyCourseSummary[]>([]);
	const [openJob, setOpenJob] = useState<{ id: string; kind: CreateJobSummary["kind"] } | null>(null);
	const [newFor, setNewFor] = useState<{ lecture: LectureSource; kind: CreateJobSummary["kind"] } | null>(null);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	const loadJobs = useCallback(async () => {
		try {
			setJobs((await api<{ jobs: CreateJobSummary[] }>("/api/create/jobs")).jobs);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);
	const loadLectures = useCallback(async () => {
		try {
			setLectures((await api<{ sources: LectureSource[] }>("/api/library")).sources);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);
	const loadCourses = useCallback(async () => {
		try {
			setCourses((await api<{ courses: StudyCourseSummary[] }>("/api/study/courses")).courses);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		void loadJobs();
		void loadLectures();
		void loadCourses();
	}, [loadJobs, loadLectures, loadCourses]);

	const anyRunning = jobs?.some((j) => j.running) ?? false;
	useEffect(() => {
		if (!anyRunning) return;
		const timer = setInterval(() => void loadJobs(), 2000);
		return () => clearInterval(timer);
	}, [anyRunning, loadJobs]);

	async function upload(files: FileList | null) {
		if (!files || files.length === 0) return;
		setUploading(true);
		try {
			const form = new FormData();
			for (const file of files) form.append("files", file);
			const res = await fetch("/api/library", { method: "POST", body: form });
			const body = (await res.json().catch(() => null)) as { results?: { fileName: string; ok: boolean; error?: string }[]; error?: string } | null;
			const failed = (body?.results ?? []).filter((r) => !r.ok);
			setError(failed.length > 0 ? failed.map((r) => `${r.fileName}: ${r.error ?? "failed"}`).join("\n") : !res.ok ? (body?.error ?? "Upload failed") : null);
			await loadLectures();
		} finally {
			setUploading(false);
			if (fileInput.current) fileInput.current.value = "";
		}
	}

	const Detail = openJob?.kind === "cards" ? CardsJobDetail : JobDetail;

	return (
		<div className="flex h-dvh flex-col" data-testid="create-view">
			<header className="flex items-center gap-2 px-3 py-2">
				<SidebarToggle />
			</header>
			<div className={`mx-auto flex w-full ${openJob?.kind === "cards" ? "max-w-6xl" : "max-w-2xl"} flex-1 flex-col gap-4 overflow-y-auto px-4 pb-10`}>
				<div className="flex items-center gap-2 pt-4 text-muted-foreground">
					<SparklesIcon className="size-4" />
					<h1 className="text-xs uppercase tracking-widest">Create — turn a PDF into study material</h1>
				</div>
				{error && (
					<p className="whitespace-pre-line rounded-md border border-red-500/40 p-3 text-sm text-red-400" role="alert">
						{error}
					</p>
				)}

				{openJob ? (
					<Detail
						jobId={openJob.id}
						courses={courses}
						onBack={() => {
							setOpenJob(null);
							void loadJobs();
						}}
						onChanged={() => void loadJobs()}
						onCourseAdded={() => void loadCourses()}
					/>
				) : (
					<>
						{newFor && lectures && (
							(() => {
								const created = (job: CreateJobSummary) => {
									setNewFor(null);
									setOpenJob({ id: job.id, kind: job.kind });
									void loadJobs();
								};
								return newFor.kind === "cards" ? (
									<NewCardsForm lecture={newFor.lecture} onCancel={() => setNewFor(null)} onCreated={created} />
								) : (
									<NewJobForm lecture={newFor.lecture} lectures={lectures} onCancel={() => setNewFor(null)} onCreated={created} />
								);
							})()
						)}

						<section className="flex flex-col gap-2" data-testid="create-library">
							<div className="flex items-center gap-2">
								<h2 className="flex-1 text-xs uppercase tracking-widest text-muted-foreground/70">Your PDFs</h2>
								<input
									ref={fileInput}
									type="file"
									accept="application/pdf"
									multiple
									hidden
									data-testid="create-upload-input"
									onChange={(e) => void upload(e.target.files)}
								/>
								<Button variant="outline" size="sm" disabled={uploading} onClick={() => fileInput.current?.click()} data-testid="create-upload">
									<FileUpIcon /> {uploading ? "Adding…" : "Add PDFs"}
								</Button>
							</div>
							{lectures === null && <p className="text-sm text-muted-foreground">Loading…</p>}
							{lectures?.length === 0 && (
								<p className="rounded-md border p-4 text-sm text-muted-foreground" data-testid="create-library-empty">
									No PDFs yet. Add your lecture slides or a question sheet; they stay in your library for lessons and for Create.
								</p>
							)}
							{lectures?.map((l) => (
								<div key={l.id} className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3" data-testid="create-lecture">
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate text-base">{l.title}</span>
										<span className="text-xs text-muted-foreground">{l.pages ?? "?"} pages</span>
									</span>
									<Button variant="outline" size="sm" onClick={() => setNewFor({ lecture: l, kind: "cards" })} data-testid="create-cards">
										Flashcards
									</Button>
									<Button variant="outline" size="sm" onClick={() => setNewFor({ lecture: l, kind: "mcq" })} data-testid="create-mcq">
										Multiple-choice test
									</Button>
								</div>
							))}
						</section>

						<section className="flex flex-col gap-2" data-testid="create-jobs">
							<h2 className="text-xs uppercase tracking-widest text-muted-foreground/70">Drafts</h2>
							{jobs?.length === 0 && <p className="text-sm text-muted-foreground">Nothing created yet.</p>}
							{jobs?.map((j) => (
								<button
									key={j.id}
									type="button"
									data-testid="create-job"
									onClick={() => setOpenJob({ id: j.id, kind: j.kind })}
									className="flex flex-col gap-1.5 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-accent"
								>
									<span className="flex items-center gap-2">
										<span className="min-w-0 flex-1 truncate text-base">{j.name}</span>
										<span className="text-xs text-muted-foreground">
											{KIND_LABEL[j.kind]} · {STATE_LABEL[j.state]}
										</span>
									</span>
									<span className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
										<span className="block h-full bg-sky-400 transition-all" style={{ width: `${j.total === 0 ? 0 : (100 * j.counts.done) / j.total}%` }} />
									</span>
									<span className="text-xs text-muted-foreground">
										{j.counts.done} of {j.total} pages · {j.drafts} drafts · {j.adopted} in your cards
										{j.counts.error > 0 && <span className="text-red-400"> · {j.counts.error} failed</span>}
										{j.blocked && <span className="text-red-400"> · needs your attention</span>}
									</span>
								</button>
							))}
						</section>

						<LegacyImport
							onImported={() => {
								void loadJobs();
								void loadLectures();
							}}
						/>
					</>
				)}
			</div>
		</div>
	);
}
