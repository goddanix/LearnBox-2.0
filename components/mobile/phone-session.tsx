"use client";

import { useState } from "react";
import { ArrowLeftIcon, BookOpenIcon, CalendarClockIcon, EllipsisIcon, GraduationCapIcon, PauseIcon, PencilIcon, Undo2Icon } from "lucide-react";
import { CardFrame } from "@/components/study/card-frame";
import { describeUnsent } from "@/src/core";
import type { StudyCourseSummary, StudyGrade } from "@/src/core";
import { PhoneCardEditor } from "./phone-card-editor";
import { NEEDS_MAC } from "./phone-course-extras";
import { PhoneCounts } from "./phone-courses";
import type { PhoneStudyApi } from "./study-api";
import { useStudySession } from "./use-study-session";

const GRADES: { grade: StudyGrade; label: string; tone: string }[] = [
	{ grade: 1, label: "Again", tone: "text-red-400" },
	{ grade: 2, label: "Hard", tone: "text-amber-400" },
	{ grade: 3, label: "Good", tone: "text-emerald-400" },
	{ grade: 4, label: "Easy", tone: "text-sky-400" },
];

/**
 * One course's review on the phone: the card fills the screen, the answer buttons sit under the thumb. Taps only —
 * no hover, no keyboard shortcuts — and every control is at least 44 points high.
 */
export function PhoneSession({
	api,
	course,
	onExit,
	onError,
	unsent,
	unsentOps,
	onBackup,
	notice,
	online = true,
	onLearn,
}: {
	api: PhoneStudyApi;
	course: StudyCourseSummary;
	onExit: () => void;
	onError?: (e: unknown) => void;
	/** Answers only this phone has, asked for when the session is done. */
	unsent?: () => number;
	/** Card changes (pause, bury, edit) only this phone has. */
	unsentOps?: () => number;
	/** Hand them to the share sheet. */
	onBackup?: () => void;
	notice?: string | null;
	/** The browser has a connection: a lesson runs on the Mac, so "Learn about this card" needs it. */
	online?: boolean;
	/** Start a lesson on the Mac about this card. */
	onLearn?: (cardId: string) => void;
}) {
	const s = useStudySession(api, course.id, onError);
	const { state, card } = s;
	const [menu, setMenu] = useState(false);
	const waiting = (unsent?.() ?? 0) + (unsentOps?.() ?? 0);
	return (
		<div className="flex h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom))] flex-col" data-testid="phone-session">
			<header className="flex items-center gap-1 px-2 py-1">
				<button type="button" onClick={onExit} aria-label="Back to courses" className="flex h-11 min-w-11 items-center justify-center gap-1 rounded-full px-2 text-sm text-muted-foreground active:bg-accent" data-testid="phone-exit">
					<ArrowLeftIcon className="size-5" />
				</button>
				<span className="min-w-0 flex-1 truncate text-center text-sm text-muted-foreground">{course.name}</span>
				{card && !s.editing && (
					<button
						type="button"
						onClick={() => setMenu((open) => !open)}
						aria-label="More for this card"
						aria-expanded={menu}
						className="flex size-11 items-center justify-center rounded-full text-muted-foreground active:bg-accent"
						data-testid="phone-more"
					>
						<EllipsisIcon className="size-5" />
					</button>
				)}
				<button
					type="button"
					onClick={s.undo}
					disabled={!s.canUndo || s.busy}
					aria-label="Undo"
					className="flex size-11 items-center justify-center rounded-full text-muted-foreground active:bg-accent disabled:opacity-30"
					data-testid="phone-undo"
				>
					<Undo2Icon className="size-5" />
				</button>
				<span className="pr-2" data-testid="phone-session-counts">
					{state && <PhoneCounts counts={state.counts} current={card?.bucket} />}
				</span>
			</header>

			{s.error && (
				<div className="mx-3 flex items-center gap-2 rounded-md border border-red-500/40 p-2 text-sm text-red-400" role="alert" data-testid="phone-error">
					<span className="min-w-0 flex-1">{s.error}</span>
					{!state && (
						<button type="button" onClick={() => void s.reload()} className="h-9 shrink-0 rounded-md border px-3 text-foreground active:bg-accent" data-testid="phone-retry">
							Retry
						</button>
					)}
				</div>
			)}

			{state && !card && (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center" data-testid="phone-done">
					<GraduationCapIcon className="size-10 text-muted-foreground" />
					<p className="text-xl">Done for today.</p>
					<p className="text-sm text-muted-foreground">
						{s.answered > 0 ? `${s.answered} card${s.answered === 1 ? "" : "s"} answered. ` : ""}
						Nothing else is due in {course.name}.
					</p>
					{onBackup && waiting > 0 && (
						<div className="flex flex-col items-center gap-2 rounded-xl border p-3" data-testid="phone-done-unsent">
							<p className="text-sm">{describeUnsent(unsent?.() ?? 0, unsentOps?.() ?? 0)} only on this phone. Save a backup file now?</p>
							<button type="button" onClick={onBackup} className="h-11 rounded-lg bg-foreground px-5 text-sm font-medium text-background active:opacity-80" data-testid="phone-done-backup">
								Save backup file
							</button>
							<p className="text-xs text-muted-foreground">Or update when your Mac is reachable: they go there.</p>
						</div>
					)}
					{notice && (
						<p className="text-sm text-muted-foreground" data-testid="phone-done-notice">
							{notice}
						</p>
					)}
					<button type="button" onClick={onExit} className="mt-2 h-12 rounded-xl border px-6 text-base active:bg-accent" data-testid="phone-done-back">
						Back to courses
					</button>
				</div>
			)}

			{card && s.editing && <PhoneCardEditor key={card.id} card={card} busy={s.busy} onSave={s.saveEdit} onCancel={() => s.setEditing(false)} />}

			{card && menu && !s.editing && (
				<div className="mx-3 mb-2 grid grid-cols-3 gap-2" role="menu" data-testid="phone-menu">
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							setMenu(false);
							s.setEditing(true);
						}}
						className="flex h-16 flex-col items-center justify-center gap-1 rounded-xl border bg-card text-xs active:bg-accent"
						data-testid="phone-menu-edit"
					>
						<PencilIcon className="size-5" />
						Edit
					</button>
					<button
						type="button"
						role="menuitem"
						disabled={s.busy}
						onClick={() => {
							setMenu(false);
							s.cardAction("bury");
						}}
						className="flex h-16 flex-col items-center justify-center gap-1 rounded-xl border bg-card text-xs active:bg-accent disabled:opacity-50"
						data-testid="phone-menu-bury"
					>
						<CalendarClockIcon className="size-5" />
						Until tomorrow
					</button>
					<button
						type="button"
						role="menuitem"
						disabled={s.busy}
						onClick={() => {
							setMenu(false);
							s.cardAction("suspend");
						}}
						className="flex h-16 flex-col items-center justify-center gap-1 rounded-xl border bg-card text-xs active:bg-accent disabled:opacity-50"
						data-testid="phone-menu-suspend"
					>
						<PauseIcon className="size-5" />
						Pause card
					</button>
					{onLearn && (
						<>
							<button
								type="button"
								role="menuitem"
								disabled={!online}
								onClick={() => {
									setMenu(false);
									onLearn(card.id);
								}}
								className="col-span-3 flex h-12 items-center justify-center gap-2 rounded-xl border bg-card text-sm active:bg-accent disabled:opacity-50"
								data-testid="phone-menu-learn"
							>
								<BookOpenIcon className="size-5" />
								Learn about this card
							</button>
							{!online && (
								<p className="col-span-3 text-center text-xs text-muted-foreground" data-testid="phone-menu-learn-hint">
									{NEEDS_MAC}
								</p>
							)}
						</>
					)}
				</div>
			)}

			{card && !s.editing && (
				<>
					<CardFrame key={`${card.id}:${s.shown}:${s.revealed ? "back" : "front"}`} card={card} revealed={s.revealed} picked={s.picked} onPick={s.setPicked} />
					<footer className="border-t px-3 pb-3 pt-3">
						{s.revealed ? (
							<div className="grid w-full grid-cols-4 gap-2">
								{GRADES.map(({ grade, label, tone }) => (
									<button
										key={grade}
										type="button"
										disabled={s.busy}
										data-testid={`phone-grade-${grade}`}
										data-suggested={s.suggested === grade || undefined}
										onClick={() => s.answer(grade)}
										className={`flex h-16 touch-manipulation select-none flex-col items-center justify-center gap-0.5 rounded-xl border bg-card active:bg-accent disabled:opacity-50 ${s.suggested === grade ? "ring-2 ring-primary" : ""}`}
									>
										<span className="text-xs tabular-nums text-muted-foreground">{card.intervals[grade]}</span>
										<span className={`text-base font-medium ${tone}`}>{label}</span>
									</button>
								))}
							</div>
						) : (
							<button
								type="button"
								onClick={s.reveal}
								className="h-16 w-full touch-manipulation select-none rounded-xl bg-foreground text-lg font-medium text-background active:opacity-80"
								data-testid="phone-reveal"
							>
								{card.kind === "mcq" ? "Check" : "Show answer"}
							</button>
						)}
					</footer>
				</>
			)}
		</div>
	);
}
