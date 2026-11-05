"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, BookOpenIcon, CalendarClockIcon, ChevronRightIcon, GraduationCapIcon, PauseIcon, PencilIcon, PlusIcon, Undo2Icon } from "lucide-react";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { STUDY_CHANGED } from "@/components/settings/study-section.tsx";
import { SidebarToggle, timeAgo } from "@/components/sidebar";
import { studyApi as api, postJson } from "@/components/study/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CardFrame } from "@/components/study/card-frame";
import { LESSON_CARDS_MAX, mcqCorrect, mcqSuggestedGrade } from "@/src/core";
import type {
	ChatListItem,
	StudyCardView,
	StudyCourseSummary,
	StudyGrade,
	StudyLinkCard,
	StudyNextResult,
	StudyQueueCounts,
	StudyWeakSpots,
} from "@/src/core";

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

/**
 * `initialCourseId` goes straight into that course and `initialCardId` opens that card first (the
 * link from a lesson back to its flashcards); both are used once — leaving the session returns
 * to the course list.
 */
export function StudyView({ initialCourseId, initialCardId }: { initialCourseId?: string; initialCardId?: string } = {}) {
	const [courses, setCourses] = useState<StudyCourseSummary[] | null>(null);
	const [lessons, setLessons] = useState<ChatListItem[]>([]);
	const [weak, setWeak] = useState<Record<string, StudyLinkCard[]>>({});
	const [active, setActive] = useState<StudyCourseSummary | null>(null);
	const [error, setError] = useState<string | null>(null);
	const linked = useRef({ course: initialCourseId, card: initialCardId });

	const loadCourses = useCallback(async () => {
		try {
			const out = await api<{ courses: StudyCourseSummary[] }>("/api/study/courses");
			setCourses(out.courses);
			setError(null);
			// The weak spots of each course (Learnbox 2.0, Slice 9): a missing list only hides it.
			const entries = await Promise.all(
				out.courses.map(async (c) => {
					try {
						const w = await api<StudyWeakSpots>(`/api/study/weak?course=${encodeURIComponent(c.id)}`);
						return [c.id, w.cards] as const;
					} catch {
						return [c.id, [] as StudyLinkCard[]] as const;
					}
				}),
			);
			setWeak(Object.fromEntries(entries));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
		// The lessons tied to a course, to cards they started from or to cards made from them (Slice 9): a missing list only hides them.
		try {
			const out = await api<{ chats?: ChatListItem[] }>("/api/chats");
			setLessons((out.chats ?? []).filter((c) => (c.kind ?? "teach") === "teach" && (c.courseId || (c.cardIds?.length ?? 0) > 0 || (c.madeCardIds?.length ?? 0) > 0)));
		} catch {
			setLessons([]);
		}
	}, []);

	useEffect(() => {
		void loadCourses();
		const onChanged = () => void loadCourses();
		window.addEventListener(STUDY_CHANGED, onChanged);
		return () => window.removeEventListener(STUDY_CHANGED, onChanged);
	}, [loadCourses]);

	// A link from a lesson: open its course once the list is there (an unknown course shows the list).
	useEffect(() => {
		const id = linked.current.course;
		if (!id || !courses) return;
		const course = courses.find((c) => c.id === id);
		if (!course) linked.current = { course: undefined, card: undefined };
		else setActive(course);
	}, [courses]);

	return (
		<div className="flex h-dvh flex-col" data-testid="study-view">
			{active ? (
				<Session
					course={active}
					lessons={lessons}
					openCardId={linked.current.course === active.id ? linked.current.card : undefined}
					onExit={() => {
						linked.current = { course: undefined, card: undefined };
						setActive(null);
						void loadCourses();
					}}
				/>
			) : (
				<CoursePicker courses={courses} lessons={lessons} weak={weak} error={error} onPick={setActive} />
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

/** Lessons of a course shown before "+N more". */
const LESSONS_SHOWN = 5;

/**
 * A course's weak spots (Learnbox 2.0, Slice 9): the cards it keeps getting wrong, most lapses
 * first. Pick some (at most LESSON_CARDS_MAX) and start a lesson on them — the draft opens with
 * the course, the cards and a suggested first message; nothing is created before it is sent.
 */
function WeakSpots({ course, cards, lessons }: { course: StudyCourseSummary; cards: StudyLinkCard[]; lessons: ChatListItem[] }) {
	const [open, setOpen] = useState(false);
	const [picked, setPicked] = useState<string[]>([]);
	if (cards.length === 0) return null;
	const toggle = (id: string) =>
		setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < LESSON_CARDS_MAX ? [...p, id] : p));
	const full = picked.length >= LESSON_CARDS_MAX;
	return (
		<div className="flex flex-col gap-1 border-t px-4 py-2 text-xs" data-testid="study-weak">
			<button
				type="button"
				data-testid="study-weak-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex items-center gap-1.5 self-start text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3 transition-transform", open && "rotate-90")} />
				Weak spots · {cards.length}
			</button>
			{open && (
				<>
					{cards.map((c) => {
						const on = picked.includes(c.id);
						const covered = lessons.some((l) => l.cardIds?.includes(c.id));
						return (
							<label key={c.id} data-testid="study-weak-card" className="flex cursor-pointer items-center gap-2 text-muted-foreground">
								<input type="checkbox" checked={on} disabled={!on && full} onChange={() => toggle(c.id)} className="shrink-0" />
								<span className="min-w-0 flex-1 truncate text-foreground/80">{c.front}</span>
								{covered && <BookOpenIcon aria-label="A lesson already covers this card" className="size-3 shrink-0" />}
								<span className="shrink-0 tabular-nums">{c.lapses} lapses</span>
							</label>
						);
					})}
					{picked.length > 0 ? (
						<Link
							href={`/chat/new?course=${encodeURIComponent(course.id)}&cards=${picked.map(encodeURIComponent).join(",")}`}
							data-testid="study-weak-learn"
							className="flex items-center gap-1.5 self-start text-foreground transition-colors hover:underline"
						>
							<BookOpenIcon aria-hidden="true" className="size-3" />
							Learn about these ({picked.length})
						</Link>
					) : (
						<span data-testid="study-weak-hint" className="self-start text-muted-foreground/70">
							Pick cards to start a lesson on them
						</span>
					)}
					{full && <span className="self-start text-muted-foreground/70">At most {LESSON_CARDS_MAX} cards per lesson</span>}
				</>
			)}
		</div>
	);
}

/** One course on the start screen: the course row (opens the review session), the lessons that belong to it and its weak spots. */
function CourseCard({
	course: c,
	lessons,
	allLessons,
	weak,
	onPick,
}: {
	course: StudyCourseSummary;
	lessons: ChatListItem[];
	/** Every lesson with a course or cards: tells which weak cards a lesson already covers. */
	allLessons: ChatListItem[];
	weak: StudyLinkCard[];
	onPick: (c: StudyCourseSummary) => void;
}) {
	const [all, setAll] = useState(false);
	const shown = all ? lessons : lessons.slice(0, LESSONS_SHOWN);
	return (
		<div className="overflow-hidden rounded-lg border bg-card" data-testid="study-course-card">
			<button
				type="button"
				data-testid="study-course"
				onClick={() => onPick(c)}
				className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-accent"
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
			<div className="flex flex-col gap-1 border-t px-4 py-2 text-xs" data-testid="study-lessons">
				{shown.map((l) => (
					<Link
						key={l.id}
						href={`/chat/${l.id}`}
						data-testid="study-lesson"
						className="flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
					>
						<BookOpenIcon aria-hidden="true" className="size-3 shrink-0" />
						<span className="min-w-0 flex-1 truncate">{l.title}</span>
						<span className="shrink-0 tabular-nums">{timeAgo(l.updatedAt)}</span>
					</Link>
				))}
				{!all && lessons.length > LESSONS_SHOWN && (
					<button type="button" onClick={() => setAll(true)} className="self-start text-muted-foreground hover:text-foreground" data-testid="study-lessons-more">
						+{lessons.length - LESSONS_SHOWN} more
					</button>
				)}
				<Link
					href={`/chat/new?course=${encodeURIComponent(c.id)}`}
					data-testid="study-new-lesson"
					className="flex items-center gap-1.5 self-start text-muted-foreground transition-colors hover:text-foreground"
				>
					<PlusIcon aria-hidden="true" className="size-3" />
					New lesson
				</Link>
			</div>
			<WeakSpots course={c} cards={weak} lessons={allLessons} />
		</div>
	);
}

function CoursePicker({
	courses,
	lessons,
	weak,
	error,
	onPick,
}: {
	courses: StudyCourseSummary[] | null;
	/** The teaching sessions tied to a course or to cards (from the sessions list). */
	lessons: ChatListItem[];
	/** Each course's weak spots, most lapses first. */
	weak: Record<string, StudyLinkCard[]>;
	error: string | null;
	onPick: (c: StudyCourseSummary) => void;
}) {
	const { open: openSettings } = useSettingsDialog();
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
						<Button variant="outline" size="sm" className="mt-3 block" onClick={() => openSettings("study")}>
							Import from Anki…
						</Button>
					</p>
				)}
				{courses?.map((c) => (
					<CourseCard
						key={c.id}
						course={c}
						lessons={lessons.filter((l) => l.courseId === c.id)}
						allLessons={lessons}
						weak={weak[c.id] ?? []}
						onPick={onPick}
					/>
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

/** What Z takes back: the latest review, suspension or burying of this session. */
interface UndoEntry {
	kind: "review" | "suspend" | "bury";
	cardId: string;
	/** The step the card was shown at (undo shows it again at that step). */
	step: number;
}

function Session({
	course,
	lessons,
	openCardId,
	onExit,
}: {
	course: StudyCourseSummary;
	/** Lessons tied to cards: the card on screen lists the ones that started from it. */
	lessons: ChatListItem[];
	/** The card to show first (a link from a lesson); the queue takes over after it. */
	openCardId?: string;
	onExit: () => void;
}) {
	const router = useRouter();
	const firstCard = useRef(openCardId);
	const [state, setState] = useState<StudyNextResult | null>(null);
	const [revealed, setRevealed] = useState(false);
	const [picked, setPicked] = useState<string[]>([]);
	const [shown, setShown] = useState(0);
	const [editing, setEditing] = useState(false);
	const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const shownAt = useRef(0);
	const answered = useRef(0);

	/** Put a (new) card on screen, front side up. */
	const show = useCallback((next: StudyNextResult) => {
		setState(next);
		setRevealed(false);
		setPicked([]);
		setEditing(false);
		setShown((n) => n + 1);
		shownAt.current = Date.now();
	}, []);

	useEffect(() => {
		let cancelled = false;
		// Kept, not consumed: Strict Mode runs this effect twice, and a session has one course.
		const open = firstCard.current ? `&card=${encodeURIComponent(firstCard.current)}` : "";
		api<StudyNextResult>(`/api/study/next?course=${encodeURIComponent(course.id)}&step=0${open}`)
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

	/** Run one server call; `then` gets its result, an error lands in the banner. */
	const act = useCallback(
		async (call: () => Promise<StudyNextResult>, then: (next: StudyNextResult) => void) => {
			setBusy(true);
			try {
				then(await call());
				setError(null);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setBusy(false);
			}
		},
		[],
	);

	const card = state?.card ?? null;
	const cardLessons = useMemo(() => (card ? lessons.filter((l) => l.cardIds?.includes(card.id) || l.madeCardIds?.includes(card.id)) : []), [card, lessons]);
	/** A lesson on this card (Slice 9): the draft opens with the course, this card and a suggested first message. */
	const learn = useCallback(() => {
		if (!card) return;
		router.push(`/chat/new?course=${encodeURIComponent(course.id)}&cards=${encodeURIComponent(card.id)}`);
	}, [card, course.id, router]);
	const suggested: StudyGrade | null = useMemo(
		() => (card?.kind === "mcq" ? mcqSuggestedGrade(mcqCorrect(card.fields), picked) : null),
		[card, picked],
	);

	const answer = useCallback(
		(grade: StudyGrade) => {
			if (!state?.card || busy) return;
			const entry: UndoEntry = { kind: "review", cardId: state.card.id, step: state.step };
			void act(
				() =>
					api<StudyNextResult>(
						"/api/study/answer",
						postJson({
							courseId: course.id,
							cardId: entry.cardId,
							grade,
							ms: Date.now() - shownAt.current,
							step: entry.step,
						}),
					),
				(next) => {
					answered.current += 1;
					setUndoStack((s) => [...s, entry]);
					show(next);
				},
			);
		},
		[state, busy, course.id, act, show],
	);

	const cardAction = useCallback(
		(kind: "suspend" | "bury") => {
			if (!state?.card || busy) return;
			const entry: UndoEntry = { kind, cardId: state.card.id, step: state.step };
			void act(
				() =>
					api<StudyNextResult>(
						"/api/study/card",
						postJson({ courseId: course.id, cardId: entry.cardId, action: kind, step: entry.step }),
					),
				(next) => {
					setUndoStack((s) => [...s, entry]);
					show(next);
				},
			);
		},
		[state, busy, course.id, act, show],
	);

	const undo = useCallback(() => {
		const entry = undoStack.at(-1);
		if (!entry || busy) return;
		const call =
			entry.kind === "review"
				? () =>
						api<StudyNextResult>(
							"/api/study/undo",
							postJson({ courseId: course.id, cardId: entry.cardId, step: entry.step }),
						)
				: () =>
						api<StudyNextResult>(
							"/api/study/card",
							postJson({
								courseId: course.id,
								cardId: entry.cardId,
								action: entry.kind === "suspend" ? "unsuspend" : "unbury",
								step: entry.step,
							}),
						);
		setUndoStack((s) => s.slice(0, -1));
		void act(call, (next) => {
			if (entry.kind === "review") answered.current = Math.max(0, answered.current - 1);
			show(next);
		});
	}, [undoStack, busy, course.id, act, show]);

	const saveEdit = useCallback(
		(fields: Record<string, string>) => {
			if (!state?.card) return;
			const cardId = state.card.id;
			void act(
				() =>
					api<StudyNextResult>(
						"/api/study/card",
						postJson({ courseId: course.id, cardId, action: "edit", fields, step: state.step }),
					),
				(next) => {
					// the edited card stays as it was on screen: same side, same picks
					setState(next);
					setEditing(false);
				},
			);
		},
		[state, course.id, act],
	);

	// Space/Enter: show answer, then the suggested grade (Good by default). 1–4: grade once the
	// answer is up. Z undo, S suspend, B bury until tomorrow, E edit, L a lesson on the card (once
	// the answer is up).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const t = e.target as HTMLElement | null;
			if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
			if (editing) return;
			const key = e.key.toLowerCase();
			if (key === "z") {
				e.preventDefault();
				undo();
				return;
			}
			if (!state?.card) return;
			if (e.key === " " || e.key === "Enter") {
				e.preventDefault();
				if (!revealed) setRevealed(true);
				else answer(suggested ?? 3);
			} else if (revealed && e.key >= "1" && e.key <= "4") {
				e.preventDefault();
				answer(Number(e.key) as StudyGrade);
			} else if (key === "s") {
				e.preventDefault();
				cardAction("suspend");
			} else if (key === "b") {
				e.preventDefault();
				cardAction("bury");
			} else if (key === "e") {
				e.preventDefault();
				setEditing(true);
			} else if (key === "l" && revealed) {
				e.preventDefault();
				learn();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [state, revealed, editing, suggested, answer, undo, cardAction, learn]);

	const tools = [
		{ id: "undo", label: "Undo (Z)", icon: Undo2Icon, run: undo, off: undoStack.length === 0 },
		{ id: "lesson", label: "Learn about this card (L)", icon: BookOpenIcon, run: learn, off: !card || !revealed },
		{ id: "edit", label: "Edit card (E)", icon: PencilIcon, run: () => setEditing(true), off: !card },
		{ id: "bury", label: "Bury until tomorrow (B)", icon: CalendarClockIcon, run: () => cardAction("bury"), off: !card },
		{ id: "suspend", label: "Suspend card (S)", icon: PauseIcon, run: () => cardAction("suspend"), off: !card },
	];

	return (
		<>
			<header className="flex items-center gap-2 px-3 py-2">
				<SidebarToggle />
				<Button variant="ghost" size="sm" className="lh-no-drag" onClick={onExit} data-testid="study-exit">
					<ArrowLeftIcon className="size-4" />
					Courses
				</Button>
				<span className="min-w-0 flex-1 truncate text-center text-sm text-muted-foreground">{course.name}</span>
				<span className="lh-no-drag flex items-center">
					{tools.map(({ id, label, icon: Icon, run, off }) => (
						<Button
							key={id}
							variant="ghost"
							size="icon-sm"
							title={label}
							aria-label={label}
							disabled={off || busy || (editing && id !== "undo")}
							onClick={run}
							data-testid={`study-${id}`}
						>
							<Icon className="size-4" />
						</Button>
					))}
				</span>
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

			{card && editing && (
				<CardEditor
					key={`${card.id}-${shown}`}
					card={card}
					busy={busy}
					onSave={saveEdit}
					onCancel={() => setEditing(false)}
				/>
			)}

			{card && !editing && (
				<>
					<CardFrame
						key={`${card.id}:${shown}:${revealed ? "back" : "front"}`}
						card={card}
						revealed={revealed}
						picked={picked}
						onPick={setPicked}
					/>
					{revealed && cardLessons.length > 0 && (
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2 text-xs text-muted-foreground" data-testid="study-card-lessons">
							<span className="flex items-center gap-1.5">
								<BookOpenIcon aria-hidden="true" className="size-3" />
								Lessons on this card
							</span>
							{cardLessons.map((l) => (
								<Link key={l.id} href={`/chat/${l.id}`} data-testid="study-card-lesson" className="max-w-xs truncate transition-colors hover:text-foreground hover:underline">
									{l.title}
								</Link>
							))}
						</div>
					)}
					<footer className="flex min-h-20 items-center justify-center border-t px-4 py-3">
						{revealed ? (
							<div className="grid w-full max-w-xl grid-cols-4 gap-2">
								{GRADES.map(({ grade, label, tone }) => (
									<button
										key={grade}
										type="button"
										disabled={busy}
										data-testid={`study-grade-${grade}`}
										data-suggested={suggested === grade || undefined}
										onClick={() => answer(grade)}
										className={`flex flex-col items-center gap-0.5 rounded-lg border bg-card px-2 py-2 transition-colors hover:bg-accent disabled:opacity-50 ${suggested === grade ? "ring-2 ring-primary" : ""}`}
									>
										<span className="text-xs text-muted-foreground tabular-nums">{card.intervals[grade]}</span>
										<span className={`text-sm font-medium ${tone}`}>{label}</span>
										<kbd className="text-[10px] text-muted-foreground/60">{grade}</kbd>
									</button>
								))}
							</div>
						) : (
							<Button size="lg" onClick={() => setRevealed(true)} data-testid="study-reveal" className="min-w-48">
								{card.kind === "mcq" ? "Check" : "Show answer"}
								<kbd className="ml-1 text-[10px] opacity-60">space</kbd>
							</Button>
						)}
					</footer>
				</>
			)}
		</>
	);
}

/** Edit a card's fields as HTML. Saves go to every card of the same Anki note. */
function CardEditor({
	card,
	busy,
	onSave,
	onCancel,
}: {
	card: StudyCardView;
	busy: boolean;
	onSave: (changed: Record<string, string>) => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState<Record<string, string>>(card.fields);
	const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => v !== card.fields[k]));
	const dirty = Object.keys(changed).length > 0;
	const save = () => {
		if (dirty && !busy) onSave(changed);
	};
	return (
		<div
			className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4"
			data-testid="study-editor"
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					onCancel();
				} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					save();
				}
			}}
		>
			{Object.keys(card.fields).map((name) => (
				<label key={name} className="flex flex-col gap-1">
					<span className="text-xs uppercase tracking-widest text-muted-foreground">{name}</span>
					<textarea
						value={draft[name] ?? ""}
						onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.value }))}
						rows={Math.min(12, Math.max(2, (draft[name] ?? "").split("\n").length))}
						spellCheck={false}
						data-testid={`study-field-${name}`}
						className="w-full resize-y rounded-md border bg-background p-2 font-mono text-sm"
					/>
				</label>
			))}
			<div className="flex items-center gap-2 pt-1">
				<span className="flex-1 text-xs text-muted-foreground" data-testid="study-editor-note">
					{card.siblings > 0
						? `Also changes ${card.siblings} other card${card.siblings === 1 ? "" : "s"} of this note.`
						: "Only this card has these fields."}
				</span>
				<Button variant="ghost" size="sm" onClick={onCancel} data-testid="study-edit-cancel">
					Cancel
				</Button>
				<Button size="sm" disabled={!dirty || busy} onClick={save} data-testid="study-edit-save">
					Save
				</Button>
			</div>
		</div>
	);
}
