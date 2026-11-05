"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StudyContextData } from "@/src/core";

/**
 * The study-context card (Learnbox 2.0, 2026-11, Slice 9): the course a lesson belongs to and the
 * flashcards it started from — the first message of a lesson begun for a course or from cards.
 * Scaffolding, not a turn: minimal, muted, collapsed by default (the graph-context card's
 * register); expand reveals what the teacher was told. The model reads the same facts through
 * the marker's own text; this card is the learner's face of it. Each card links to the review
 * screen with that card open — the way back from a lesson to its flashcards.
 */

const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function examPhrase(course: StudyContextData["course"]): string | null {
	if (!course.deadline || course.daysToExam === null) return null;
	if (course.daysToExam < 0) return "exam passed";
	if (course.daysToExam === 0) return "exam today";
	return `exam in ${noun(course.daysToExam, "day", "days")}`;
}

export function StudyContextCard({ data }: { data: StudyContextData }) {
	const [open, setOpen] = useState(false);
	const course = data?.course;
	if (!course) return null;
	const cards = data.cards ?? [];
	const weak = data.weak ?? [];
	const exam = examPhrase(course);
	const cardHref = (id: string) => `/study?course=${encodeURIComponent(course.id)}&card=${encodeURIComponent(id)}`;
	return (
		<div data-testid="study-context-card" className="my-1">
			<button
				type="button"
				data-testid="study-context-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="font-medium">Course</span>
				<span className="min-w-0 flex-1 truncate">
					{course.name}
					{exam ? ` · ${exam}` : ""}
					{cards.length > 0 ? ` · ${noun(cards.length, "card", "cards")}` : ""}
				</span>
			</button>
			{open && (
				<div data-testid="study-context-body" className="mt-1 space-y-2 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					<div className="leading-relaxed">
						<span className="font-medium text-foreground/80">{course.name}</span>
						<span className="text-muted-foreground">
							{" "}
							— {course.deadline ? `exam ${course.deadline}${exam ? ` (${exam})` : ""}` : "no exam date"} · {noun(data.due, "card", "cards")} due, {data.newToday} new today
						</span>
					</div>
					{course.topics.length > 0 && (
						<div className="leading-relaxed text-muted-foreground">
							Topics: {course.topics.join("; ")}
							{course.strictTopics ? " (only these topics count)" : ""}
						</div>
					)}
					{cards.length > 0 && (
						<div className="space-y-1">
							<div className="font-medium text-foreground/80">Cards this lesson started from</div>
							{cards.map((c) => (
								<div key={c.id} data-testid={`study-context-card-${c.id}`} className="leading-relaxed">
									<Link href={cardHref(c.id)} data-testid="study-context-card-open" className="text-foreground/80 underline-offset-2 hover:underline">
										{c.front}
									</Link>
									<span className="text-muted-foreground">
										{" "}
										— {c.back} · {noun(c.lapses, "lapse", "lapses")}
									</span>
								</div>
							))}
						</div>
					)}
					{weak.length > 0 && (
						<div className="space-y-1">
							<div className="font-medium text-foreground/80">Weakest cards of the course</div>
							{weak.map((c) => (
								<div key={c.id} className="leading-relaxed text-muted-foreground">
									<Link href={cardHref(c.id)} className="underline-offset-2 hover:underline">
										{c.front}
									</Link>{" "}
									· {noun(c.lapses, "lapse", "lapses")}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
