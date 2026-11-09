"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LectureContextData } from "@/src/core";

/**
 * The lecture-context card (Learnbox, 2026-10): the session's lecture pick —
 * message[0] of a session started with lectures. Scaffolding, not a turn:
 * minimal, muted, collapsed by default (the graph-context card's register);
 * expand reveals each lecture's picked topics with their pages and depth.
 * The model reads the same pick through the marker's own text; this card is
 * the learner's face of it.
 */
export function LectureContextCard({ data }: { data: LectureContextData }) {
	const [open, setOpen] = useState(false);
	const lectures = data?.lectures ?? [];
	const topics = lectures.reduce((n, l) => n + l.topics.length, 0);
	return (
		<div data-testid="lecture-context-card" className="my-1">
			<button
				type="button"
				data-testid="lecture-context-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="font-medium">Lectures</span>
				<span className="min-w-0 flex-1 truncate">
					{topics} {topics === 1 ? "topic" : "topics"} · {lectures.length} {lectures.length === 1 ? "lecture" : "lectures"}
				</span>
			</button>
			{open && (
				<div data-testid="lecture-context-body" className="mt-1 space-y-2 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					{lectures.map((lecture) => (
						<div key={lecture.id}>
							<div className="font-medium text-foreground/80">{lecture.title}</div>
							{lecture.topics.map((t) => (
								<div key={t.id} className="leading-relaxed">
									<span className="text-foreground/80">{t.title}</span>
									<span className="text-muted-foreground">
										{" "}
										— pp. {t.pageStart}-{t.pageEnd} · {t.depth}
									</span>
								</div>
							))}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
