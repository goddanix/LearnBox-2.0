"use client";

import { ArrowLeftIcon, GraduationCapIcon, Undo2Icon } from "lucide-react";
import { CardFrame } from "@/components/study/card-frame";
import type { StudyCourseSummary, StudyGrade } from "@/src/core";
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
export function PhoneSession({ api, course, onExit, onError }: { api: PhoneStudyApi; course: StudyCourseSummary; onExit: () => void; onError?: (e: unknown) => void }) {
	const s = useStudySession(api, course.id, onError);
	const { state, card } = s;
	return (
		<div className="flex h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom))] flex-col" data-testid="phone-session">
			<header className="flex items-center gap-1 px-2 py-1">
				<button type="button" onClick={onExit} aria-label="Back to courses" className="flex h-11 min-w-11 items-center justify-center gap-1 rounded-full px-2 text-sm text-muted-foreground active:bg-accent" data-testid="phone-exit">
					<ArrowLeftIcon className="size-5" />
				</button>
				<span className="min-w-0 flex-1 truncate text-center text-sm text-muted-foreground">{course.name}</span>
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
					<button type="button" onClick={onExit} className="mt-2 h-12 rounded-xl border px-6 text-base active:bg-accent" data-testid="phone-done-back">
						Back to courses
					</button>
				</div>
			)}

			{card && (
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
