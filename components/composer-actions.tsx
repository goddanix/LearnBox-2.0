"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { BookOpenIcon, DumbbellIcon, LayersIcon } from "lucide-react";

/** Home and the draft share one wrapping action row. Picker controls lead
 * (node picks, then the lecture pick); setup is centered only when it is the
 * sole action. */
export function ComposerActions({ picker, lectures, course, setup }: { picker?: ReactNode; lectures?: ReactNode; course?: ReactNode; setup?: ReactNode }) {
	if (!picker && !lectures && !course && !setup) return null;
	return (
		<div
			data-testid="composer-actions"
			className={`pointer-events-auto mb-2 flex flex-wrap items-center gap-2 ${picker || lectures || course ? "justify-start" : "justify-center"}`}
		>
			{picker}
			{lectures}
			{course}
			{setup}
		</div>
	);
}

/** The lecture pill (Learnbox): dashed "Add lectures" when nothing is picked,
 * topic count + Clear once the learner has picked topics from their lectures. */
export function LecturePickerControl({ topics, onOpen, onClear }: {
	topics: number;
	onOpen?: () => void;
	onClear?: () => void;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<button
				type="button"
				data-testid="lectures-chip"
				onClick={onOpen}
				className={
					"flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors " +
					(topics > 0
						? "border-border bg-card text-foreground hover:bg-accent"
						: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")
				}
			>
				<BookOpenIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				{topics > 0 ? `${topics} ${topics === 1 ? "lecture topic" : "lecture topics"}` : "Add lectures"}
			</button>
			{topics > 0 && (
				<button
					type="button"
					data-testid="lectures-chip-clear"
					onClick={onClear}
					className="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Clear
				</button>
			)}
		</div>
	);
}

/** Count and Clear stay together if the setup action wraps onto another line.
 * These are node counts, even when a whole chain supplied the selection. */
export function NodePickerControl({ count, onOpen, onClear, cardsHref }: {
	count: number;
	onOpen?: () => void;
	onClear?: () => void;
	/** Where "Make cards" leads (Create's form for flashcards from the picked statements); absent = no such button. */
	cardsHref?: string;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<button
				type="button"
				data-testid="practice-props-chip"
				onClick={onOpen}
				className={
					"flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors " +
					(count > 0
						? "border-border bg-card text-foreground hover:bg-accent"
						: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")
				}
			>
				<DumbbellIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				{count > 0 ? `${count} ${count === 1 ? "node" : "nodes"} selected` : "Pick nodes"}
			</button>
			{count > 0 && (
				<button
					type="button"
					data-testid="practice-props-clear"
					onClick={onClear}
					className="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Clear
				</button>
			)}
			{count > 0 && cardsHref && (
				<Link
					href={cardsHref}
					data-testid="practice-props-cards"
					title="Make flashcards from the picked statements"
					className="flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<LayersIcon aria-hidden="true" className="size-3.5" />
					Make cards
				</Link>
			)}
		</div>
	);
}
