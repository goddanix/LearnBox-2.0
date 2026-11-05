"use client";

import { DownloadIcon, GraduationCapIcon, RefreshCwIcon } from "lucide-react";
import { describeUnsent } from "@/src/core";
import type { PhoneLesson, StudyCourseSummary, StudyLinkCard, StudyQueueCounts } from "@/src/core";
import { PhoneLessonList, PhoneWeakSpots } from "./phone-course-extras";
import type { PullProgress } from "./pull-deck";

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

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string, now: Date = new Date()): string {
	const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.floor(hours / 24)} days ago`;
}

/** What the update is doing, in words. */
export function progressText(p: PullProgress): string {
	if (p.phase === "send") return "Sending your answers…";
	if (p.phase === "deck") return "Getting your cards…";
	return p.total === 0 ? "Pictures are up to date." : `Getting pictures… ${p.done} / ${p.total}`;
}

/** The phone's start page: which course? */
export function PhoneCourses({
	courses,
	error,
	deviceName,
	syncedAt,
	unsent,
	unsentOps = 0,
	updating,
	updated,
	notice,
	weak = {},
	lessons = {},
	online = true,
	onPick,
	onLearn,
	onOpenLesson,
	onUpdate,
	onBackup,
	onRestore,
}: {
	courses: StudyCourseSummary[] | null;
	error: string | null;
	deviceName?: string | null;
	/** When the Mac's deck was last taken in. */
	syncedAt: string;
	/** Answers given here that the Mac does not have yet. */
	unsent: number;
	/** Card changes (pause, bury, edit) made here that the Mac does not have yet. */
	unsentOps?: number;
	updating: PullProgress | null;
	/** What the last update did, in a sentence. */
	updated: string | null;
	/** What the last backup action did, in a sentence. */
	notice: string | null;
	/** Each course's weak spots (from this phone's own answers) and lessons (from the Mac; empty while offline). */
	weak?: Record<string, StudyLinkCard[]>;
	lessons?: Record<string, PhoneLesson[]>;
	/** The browser has a connection: lessons run on the Mac, so starting one needs it. */
	online?: boolean;
	onPick: (c: StudyCourseSummary) => void;
	/** Start a lesson on the Mac about these cards of a course. */
	onLearn?: (courseId: string, cardIds: string[]) => void;
	onOpenLesson?: (chatId: string) => void;
	onUpdate: () => void;
	/** Hand the answers only this phone has to the share sheet. */
	onBackup: () => void;
	/** Read a backup file's answers in. */
	onRestore: (file: File) => void;
}) {
	return (
		<main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-3 px-4 pb-10 pt-4" data-testid="phone-courses">
			<header className="flex items-center gap-2 text-muted-foreground">
				<GraduationCapIcon className="size-5" aria-hidden="true" />
				<h1 className="flex-1 font-title text-2xl text-foreground">Learnbox</h1>
				<button
					type="button"
					onClick={onUpdate}
					disabled={updating !== null}
					aria-label="Update from your Mac"
					className="flex size-11 items-center justify-center rounded-full active:bg-accent disabled:opacity-40"
					data-testid="phone-update"
				>
					<RefreshCwIcon className={`size-5 ${updating ? "animate-spin" : ""}`} />
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
					No courses yet. Import your cards on the Mac, then update.
				</p>
			)}
			{courses?.map((c) => (
				<div key={c.id} className="overflow-hidden rounded-xl border bg-card" data-testid="phone-course-card">
					<button type="button" onClick={() => onPick(c)} data-testid="phone-course" className="flex min-h-20 w-full items-center gap-4 px-4 py-3 text-left active:bg-accent">
						<span className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="truncate text-lg">{c.name}</span>
							<span className="text-xs text-muted-foreground">
								{c.total} card{c.total === 1 ? "" : "s"}
								{c.daysLeft !== null && ` · exam in ${c.daysLeft} day${c.daysLeft === 1 ? "" : "s"}`}
							</span>
						</span>
						<PhoneCounts counts={c.counts} />
					</button>
					{onLearn && (weak[c.id]?.length ?? 0) > 0 && <PhoneWeakSpots cards={weak[c.id]!} online={online} onLearn={(ids) => onLearn(c.id, ids)} />}
					{onOpenLesson && (lessons[c.id]?.length ?? 0) > 0 && <PhoneLessonList lessons={lessons[c.id]!} onOpen={onOpenLesson} />}
				</div>
			))}
			<p className="mt-2 text-xs text-muted-foreground/70">
				<span className="text-sky-400">new</span> · <span className="text-red-400">learning</span> · <span className="text-emerald-400">due</span>
				{deviceName ? ` · ${deviceName}` : ""}
			</p>
			<p className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-testid="phone-sync">
				<span>{updating ? progressText(updating) : `Cards from your Mac: ${ago(syncedAt)}.`}</span>
				{updated && !updating && <span data-testid="phone-updated">{updated}</span>}
				{unsent + unsentOps > 0 && <span data-testid="phone-unsent">{describeUnsent(unsent, unsentOps)} only on this phone so far.</span>}
				{notice && <span data-testid="phone-notice">{notice}</span>}
			</p>
			<div className="flex flex-wrap gap-2 text-sm">
				{unsent + unsentOps > 0 && (
					<button type="button" onClick={onBackup} className="flex h-11 items-center rounded-lg border px-4 active:bg-accent" data-testid="phone-backup">
						Save backup file
					</button>
				)}
				<label className="flex h-11 cursor-pointer items-center rounded-lg border px-4 active:bg-accent" data-testid="phone-restore">
					Read backup file
					<input
						type="file"
						accept="application/json,.json"
						className="sr-only"
						data-testid="phone-restore-input"
						onChange={(e) => {
							const file = e.target.files?.[0];
							e.target.value = "";
							if (file) onRestore(file);
						}}
					/>
				</label>
			</div>
		</main>
	);
}

/** The first run: nothing on the phone yet; the cards come from the Mac. */
export function PhoneSetup({ updating, error, onStart }: { updating: PullProgress | null; error: string | null; onStart: () => void }) {
	return (
		<main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-4 px-4 py-10" data-testid="phone-setup">
			<h1 className="font-title text-2xl">Learnbox</h1>
			<p className="text-sm text-muted-foreground">
				This phone is paired. Get your cards from the Mac (Tailscale on, the Mac awake with Learnbox open) — after that you can study anywhere, with or without a connection.
			</p>
			{error && (
				<p className="rounded-md border border-red-500/40 p-3 text-sm text-red-400" role="alert" data-testid="phone-error">
					{error}
				</p>
			)}
			<button
				type="button"
				onClick={onStart}
				disabled={updating !== null}
				className="flex h-14 items-center justify-center gap-2 rounded-xl bg-foreground text-base font-medium text-background disabled:opacity-60"
				data-testid="phone-get-cards"
			>
				<DownloadIcon className="size-5" />
				{updating ? progressText(updating) : "Get my cards"}
			</button>
		</main>
	);
}
