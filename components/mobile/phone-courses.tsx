"use client";

import { GraduationCapIcon, RefreshCwIcon } from "lucide-react";
import type { StudyCourseSummary, StudyQueueCounts } from "@/src/core";

/** new · learning · due, the same colours as on the Mac, but big enough to read at a glance. */
export function PhoneCounts({ counts, current }: { counts: StudyQueueCounts; current?: "new" | "learning" | "review" }) {
	const cell = (key: keyof StudyQueueCounts, tone: string, label: string) => (
		<span className={`tabular-nums ${tone} ${current === key ? "underline underline-offset-4" : ""}`} aria-label={`${counts[key]} ${label}`}>
			{counts[key]}
		</span>
	);
	return (
		<span className="flex items-center gap-3 text-lg font-medium" data-testid="phone-counts">
			{cell("new", "text-sky-400", "new")}
			{cell("learning", "text-red-400", "learning")}
			{cell("review", "text-emerald-400", "due")}
		</span>
	);
}

/** The phone's start page: which course? */
export function PhoneCourses({
	courses,
	error,
	deviceName,
	onPick,
	onRefresh,
}: {
	courses: StudyCourseSummary[] | null;
	error: string | null;
	deviceName?: string | null;
	onPick: (c: StudyCourseSummary) => void;
	onRefresh: () => void;
}) {
	return (
		<main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-3 px-4 pb-10 pt-4" data-testid="phone-courses">
			<header className="flex items-center gap-2 text-muted-foreground">
				<GraduationCapIcon className="size-5" aria-hidden="true" />
				<h1 className="flex-1 font-title text-2xl text-foreground">Learnbox</h1>
				<button type="button" onClick={onRefresh} aria-label="Refresh" className="flex size-11 items-center justify-center rounded-full active:bg-accent" data-testid="phone-refresh">
					<RefreshCwIcon className="size-5" />
				</button>
			</header>
			{error && (
				<p className="rounded-md border border-red-500/40 p-3 text-sm text-red-400" role="alert" data-testid="phone-error">
					{error}
				</p>
			)}
			{courses === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
			{courses?.length === 0 && (
				<p className="rounded-md border p-4 text-sm text-muted-foreground" data-testid="phone-empty">
					No courses yet. Import your cards on the Mac, then refresh.
				</p>
			)}
			{courses?.map((c) => (
				<button
					key={c.id}
					type="button"
					onClick={() => onPick(c)}
					data-testid="phone-course"
					className="flex min-h-20 w-full items-center gap-4 rounded-xl border bg-card px-4 py-3 text-left active:bg-accent"
				>
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="truncate text-lg">{c.name}</span>
						<span className="text-xs text-muted-foreground">
							{c.total} card{c.total === 1 ? "" : "s"}
							{c.daysLeft !== null && ` · exam in ${c.daysLeft} day${c.daysLeft === 1 ? "" : "s"}`}
						</span>
					</span>
					<PhoneCounts counts={c.counts} />
				</button>
			))}
			<p className="mt-2 text-xs text-muted-foreground/70">
				<span className="text-sky-400">new</span> · <span className="text-red-400">learning</span> · <span className="text-emerald-400">due</span>
				{deviceName ? ` · ${deviceName}` : ""}
			</p>
		</main>
	);
}
