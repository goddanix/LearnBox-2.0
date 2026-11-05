"use client";

import { useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { suggestedFirstMessage } from "@/src/core";
import type { StudyLinkCard } from "@/src/core";
import { NEEDS_MAC } from "./phone-course-extras";

/**
 * The start of a lesson from the phone, as the draft on the Mac: what the lesson is about (the cards, in plain text),
 * and a first message the learner may change — it names the lesson and is sent as turn 1. Nothing exists on the Mac
 * until Start; the lesson itself runs there, so Start needs a connection.
 */
export function PhoneLessonStart({
	courseName,
	count,
	faces,
	online,
	busy,
	error,
	onStart,
	onBack,
}: {
	courseName: string;
	/** How many cards the lesson starts from (0: about the whole course). */
	count: number;
	/** Those cards' faces when the phone has them. */
	faces: StudyLinkCard[] | null;
	online: boolean;
	busy: boolean;
	error: string | null;
	onStart: (text: string) => void;
	onBack: () => void;
}) {
	const [text, setText] = useState(() => (count > 0 ? suggestedFirstMessage(count) : ""));
	const ready = online && !busy && text.trim().length > 0;
	return (
		<main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-3 px-4 pb-8 pt-2" data-testid="phone-lesson-start">
			<header className="flex items-center gap-1">
				<button type="button" onClick={onBack} aria-label="Back" className="flex size-11 items-center justify-center rounded-full text-muted-foreground active:bg-accent" data-testid="phone-lesson-start-back">
					<ArrowLeftIcon className="size-5" />
				</button>
				<h1 className="min-w-0 flex-1 truncate text-center text-sm text-muted-foreground">{courseName}</h1>
				<span className="size-11" aria-hidden="true" />
			</header>
			<p className="text-base" data-testid="phone-lesson-start-about">
				{count === 0 ? "A lesson about this course" : count === 1 ? "A lesson about this card" : `A lesson about these ${count} cards`}
			</p>
			{faces && faces.length > 0 && (
				<ul className="flex flex-col gap-2" data-testid="phone-lesson-start-cards">
					{faces.map((c) => (
						<li key={c.id} className="rounded-xl border bg-card p-3 text-sm">
							<p>{c.front}</p>
							<p className="mt-1 text-muted-foreground">{c.back}</p>
						</li>
					))}
				</ul>
			)}
			<label className="flex flex-col gap-1 text-xs text-muted-foreground">
				Your first message
				<textarea
					value={text}
					onChange={(e) => setText(e.target.value)}
					rows={5}
					placeholder="What do you want to understand?"
					className="min-h-28 rounded-xl border bg-card p-3 text-base text-foreground"
					data-testid="phone-lesson-start-text"
				/>
			</label>
			{error && (
				<p className="rounded-md border border-red-500/40 p-3 text-sm text-red-400" role="alert" data-testid="phone-lesson-start-error">
					{error}
				</p>
			)}
			<button
				type="button"
				onClick={() => onStart(text.trim())}
				disabled={!ready}
				className="h-14 rounded-xl bg-foreground text-base font-medium text-background active:opacity-80 disabled:opacity-40"
				data-testid="phone-lesson-start-go"
			>
				{busy ? "Starting…" : "Start lesson"}
			</button>
			<p className="text-xs text-muted-foreground" data-testid="phone-lesson-start-hint">
				{online ? "The lesson runs with Claude on your Mac." : NEEDS_MAC}
			</p>
		</main>
	);
}
