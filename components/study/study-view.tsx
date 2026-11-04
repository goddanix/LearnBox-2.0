"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, GraduationCapIcon } from "lucide-react";
import { SidebarToggle } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { cardDocument } from "@/src/core";
import type { StudyCardView, StudyCourseSummary, StudyGrade, StudyNextResult, StudyQueueCounts } from "@/src/core";

/**
 * The review screen. Two states: the course list ("which course?") and one
 * course's session. The server is stateless — it re-derives the queue from
 * the ledgers on every call — so the session only carries `step` (the
 * new/new/again pattern's position) and the card on screen.
 */

const GRADES: { grade: StudyGrade; label: string; tone: string }[] = [
	{ grade: 1, label: "Again", tone: "text-red-400" },
	{ grade: 2, label: "Hard", tone: "text-amber-400" },
	{ grade: 3, label: "Good", tone: "text-emerald-400" },
	{ grade: 4, label: "Easy", tone: "text-sky-400" },
];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `Request failed (${res.status})`);
	}
	return (await res.json()) as T;
}

export function StudyView() {
	const [courses, setCourses] = useState<StudyCourseSummary[] | null>(null);
	const [active, setActive] = useState<StudyCourseSummary | null>(null);
	const [error, setError] = useState<string | null>(null);

	const loadCourses = useCallback(async () => {
		try {
			const out = await api<{ courses: StudyCourseSummary[] }>("/api/study/courses");
			setCourses(out.courses);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		void loadCourses();
	}, [loadCourses]);

	return (
		<div className="flex h-dvh flex-col" data-testid="study-view">
			{active ? (
				<Session
					course={active}
					onExit={() => {
						setActive(null);
						void loadCourses();
					}}
				/>
			) : (
				<CoursePicker courses={courses} error={error} onPick={setActive} />
			)}
		</div>
	);
}

// ─── course list ────────────────────────────────────────────────────────────

function Counts({ counts, current }: { counts: StudyQueueCounts; current?: "new" | "learning" | "review" }) {
	const cell = (key: keyof StudyQueueCounts, tone: string) => (
		<span
			className={`tabular-nums ${tone} ${current === key ? "underline underline-offset-4" : ""}`}
			title={key === "new" ? "New" : key === "learning" ? "Learning" : "Due"}
		>
			{counts[key]}
		</span>
	);
	return (
		<span className="flex items-center gap-2 font-medium">
			{cell("new", "text-sky-400")}
			{cell("learning", "text-red-400")}
			{cell("review", "text-emerald-400")}
		</span>
	);
}

function CoursePicker({
	courses,
	error,
	onPick,
}: {
	courses: StudyCourseSummary[] | null;
	error: string | null;
	onPick: (c: StudyCourseSummary) => void;
}) {
	return (
		<>
			<header className="flex items-center gap-2 px-3 py-2">
				<SidebarToggle />
			</header>
			<div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3 overflow-y-auto px-4 pb-10">
				<div className="flex items-center gap-2 pt-4 text-muted-foreground">
					<GraduationCapIcon className="size-4" />
					<h1 className="text-xs uppercase tracking-widest">Study — choose a course</h1>
				</div>
				{error && (
					<p className="rounded-md border border-red-500/40 p-3 text-sm text-red-400" role="alert">
						{error}
					</p>
				)}
				{courses === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
				{courses?.length === 0 && (
					<p className="rounded-md border p-4 text-sm text-muted-foreground" data-testid="study-empty">
						No courses yet. Import your Anki collection or create cards from a PDF, and they show up here.
					</p>
				)}
				{courses?.map((c) => (
					<button
						key={c.id}
						type="button"
						data-testid="study-course"
						onClick={() => onPick(c)}
						className="flex items-center gap-4 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-accent"
					>
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="truncate text-base">{c.name}</span>
							<span className="text-xs text-muted-foreground">
								{c.total} cards
								{c.daysLeft !== null && ` · exam in ${c.daysLeft} day${c.daysLeft === 1 ? "" : "s"} (${c.newQuota} new/day)`}
							</span>
						</span>
						<Counts counts={c.counts} />
					</button>
				))}
				<p className="text-xs text-muted-foreground/70">
					<span className="text-sky-400">new</span> · <span className="text-red-400">learning</span> ·{" "}
					<span className="text-emerald-400">due</span>
				</p>
			</div>
		</>
	);
}

// ─── one course's session ───────────────────────────────────────────────────

function Session({ course, onExit }: { course: StudyCourseSummary; onExit: () => void }) {
	const [state, setState] = useState<StudyNextResult | null>(null);
	const [revealed, setRevealed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const shownAt = useRef(0);
	const answered = useRef(0);

	const show = useCallback((next: StudyNextResult) => {
		setState(next);
		setRevealed(false);
		shownAt.current = Date.now();
	}, []);

	useEffect(() => {
		let cancelled = false;
		api<StudyNextResult>(`/api/study/next?course=${encodeURIComponent(course.id)}&step=0`)
			.then((r) => {
				if (!cancelled) show(r);
			})
			.catch((e: unknown) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [course.id, show]);

	const answer = useCallback(
		async (grade: StudyGrade) => {
			if (!state?.card || busy) return;
			setBusy(true);
			try {
				const next = await api<StudyNextResult>("/api/study/answer", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						courseId: course.id,
						cardId: state.card.id,
						grade,
						ms: Date.now() - shownAt.current,
						step: state.step,
					}),
				});
				answered.current += 1;
				show(next);
				setError(null);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setBusy(false);
			}
		},
		[state, busy, course.id, show],
	);

	// Space/Enter: show answer, then Good. 1–4: grade (once the answer is up).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const t = e.target as HTMLElement | null;
			if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
			if (!state?.card) return;
			if (e.key === " " || e.key === "Enter") {
				e.preventDefault();
				if (!revealed) setRevealed(true);
				else void answer(3);
			} else if (revealed && e.key >= "1" && e.key <= "4") {
				e.preventDefault();
				void answer(Number(e.key) as StudyGrade);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [state, revealed, answer]);

	const card = state?.card ?? null;

	return (
		<>
			<header className="flex items-center gap-2 px-3 py-2">
				<SidebarToggle />
				<Button variant="ghost" size="sm" className="lh-no-drag" onClick={onExit} data-testid="study-exit">
					<ArrowLeftIcon className="size-4" />
					Courses
				</Button>
				<span className="min-w-0 flex-1 truncate text-center text-sm text-muted-foreground">{course.name}</span>
				<span data-testid="study-counts">
					{state && <Counts counts={state.counts} current={card?.bucket} />}
				</span>
			</header>

			{error && (
				<p className="mx-4 rounded-md border border-red-500/40 p-2 text-sm text-red-400" role="alert">
					{error}
				</p>
			)}

			{state && !card && (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center" data-testid="study-done">
					<GraduationCapIcon className="size-8 text-muted-foreground" />
					<p className="text-lg">Done for today.</p>
					<p className="text-sm text-muted-foreground">
						{answered.current > 0 ? `${answered.current} card${answered.current === 1 ? "" : "s"} answered. ` : ""}
						Nothing else is due in {course.name}.
					</p>
					<Button variant="outline" onClick={onExit}>
						Back to courses
					</Button>
				</div>
			)}

			{card && (
				<>
					<CardFrame card={card} revealed={revealed} />
					<footer className="flex min-h-20 items-center justify-center border-t px-4 py-3">
						{revealed ? (
							<div className="grid w-full max-w-xl grid-cols-4 gap-2">
								{GRADES.map(({ grade, label, tone }) => (
									<button
										key={grade}
										type="button"
										disabled={busy}
										data-testid={`study-grade-${grade}`}
										onClick={() => void answer(grade)}
										className="flex flex-col items-center gap-0.5 rounded-lg border bg-card px-2 py-2 transition-colors hover:bg-accent disabled:opacity-50"
									>
										<span className="text-xs text-muted-foreground tabular-nums">{card.intervals[grade]}</span>
										<span className={`text-sm font-medium ${tone}`}>{label}</span>
										<kbd className="text-[10px] text-muted-foreground/60">{grade}</kbd>
									</button>
								))}
							</div>
						) : (
							<Button size="lg" onClick={() => setRevealed(true)} data-testid="study-reveal" className="min-w-48">
								Show answer
								<kbd className="ml-1 text-[10px] opacity-60">space</kbd>
							</Button>
						)}
					</footer>
				</>
			)}
		</>
	);
}

/** The card in a sandboxed, script-free iframe: card HTML is deck content, never trusted. */
function CardFrame({ card, revealed }: { card: StudyCardView; revealed: boolean }) {
	const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
	const srcDoc = useMemo(
		() => cardDocument(revealed ? card.back : card.front, { dark }),
		[card, revealed, dark],
	);
	return (
		<div className="min-h-0 flex-1" data-testid="study-card">
			<iframe
				title="Card"
				sandbox=""
				srcDoc={srcDoc}
				className="size-full border-0 bg-transparent"
				data-kind={card.kind}
				data-split={card.split}
			/>
		</div>
	);
}
