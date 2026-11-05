"use client";

import { useState } from "react";
import { BookOpenIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { LESSON_CARDS_MAX } from "@/src/core";
import type { PhoneLesson, StudyLinkCard } from "@/src/core";

/** Words for the greyed-out state: lessons run on the Mac, so they need a connection to it. */
export const NEEDS_MAC = "Needs a connection to your Mac.";

/**
 * A course's weak spots on the phone: the cards it keeps getting wrong, most lapses first, from the phone's own
 * answers (so the list shows offline). Pick some (at most LESSON_CARDS_MAX) and start a lesson on them; starting needs
 * the Mac, so offline the button is grey with the reason beside it.
 */
export function PhoneWeakSpots({ cards, online, onLearn }: { cards: StudyLinkCard[]; online: boolean; onLearn: (cardIds: string[]) => void }) {
	const [open, setOpen] = useState(false);
	const [picked, setPicked] = useState<string[]>([]);
	const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < LESSON_CARDS_MAX ? [...p, id] : p));
	const full = picked.length >= LESSON_CARDS_MAX;
	return (
		<div className="flex flex-col border-t text-sm" data-testid="phone-weak">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				className="flex min-h-11 items-center gap-2 px-4 text-left text-muted-foreground active:bg-accent"
				data-testid="phone-weak-toggle"
			>
				{open ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
				Weak spots · {cards.length}
			</button>
			{open && (
				<div className="flex flex-col gap-1 px-4 pb-3">
					{cards.map((c) => (
						<label key={c.id} className="flex min-h-11 cursor-pointer items-center gap-3 text-muted-foreground" data-testid="phone-weak-card">
							<input type="checkbox" className="size-5 shrink-0" checked={picked.includes(c.id)} disabled={!picked.includes(c.id) && full} onChange={() => toggle(c.id)} />
							<span className="min-w-0 flex-1 truncate">{c.front}</span>
							<span className="shrink-0 tabular-nums text-xs">{c.lapses}×</span>
						</label>
					))}
					<button
						type="button"
						disabled={!online || picked.length === 0}
						onClick={() => onLearn(picked)}
						className="mt-1 h-11 self-start rounded-lg border px-4 text-foreground active:bg-accent disabled:text-muted-foreground disabled:opacity-50"
						data-testid="phone-weak-learn"
					>
						Learn about these{picked.length > 0 ? ` (${picked.length})` : ""}
					</button>
					<span className="text-xs text-muted-foreground/70" data-testid="phone-weak-hint">
						{!online ? NEEDS_MAC : full ? `At most ${LESSON_CARDS_MAX} cards per lesson` : picked.length === 0 ? "Pick cards to start a lesson on them" : ""}
					</span>
				</div>
			)}
		</div>
	);
}

/** Lessons of a course shown before "+N more". */
const LESSONS_SHOWN = 5;

/** A course's lessons on the Mac, latest first: tap one to go on with it. Only listed while the phone can ask the Mac. */
export function PhoneLessonList({ lessons, onOpen }: { lessons: PhoneLesson[]; onOpen: (id: string) => void }) {
	const [all, setAll] = useState(false);
	const shown = all ? lessons : lessons.slice(0, LESSONS_SHOWN);
	return (
		<div className="flex flex-col border-t text-sm" data-testid="phone-lessons">
			<span className="flex min-h-11 items-center gap-2 px-4 text-muted-foreground">
				<BookOpenIcon className="size-4" />
				Lessons · {lessons.length}
			</span>
			{shown.map((l) => (
				<button key={l.id} type="button" onClick={() => onOpen(l.id)} className="flex min-h-11 items-center gap-2 px-4 pb-1 text-left active:bg-accent" data-testid="phone-lesson">
					<span className="min-w-0 flex-1 truncate">{l.title}</span>
					{l.pendingQuestion && <span className="shrink-0 text-xs text-sky-400">question waiting</span>}
					{l.busy && <span className="shrink-0 text-xs text-muted-foreground">writing…</span>}
				</button>
			))}
			{!all && lessons.length > LESSONS_SHOWN && (
				<button type="button" onClick={() => setAll(true)} className="min-h-11 px-4 text-left text-muted-foreground active:bg-accent" data-testid="phone-lessons-more">
					+{lessons.length - LESSONS_SHOWN} more
				</button>
			)}
		</div>
	);
}
