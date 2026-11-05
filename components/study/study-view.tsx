"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, BookOpenIcon, CalendarClockIcon, GraduationCapIcon, PauseIcon, PencilIcon, PlusIcon, Undo2Icon } from "lucide-react";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { STUDY_CHANGED } from "@/components/settings/study-section.tsx";
import { SidebarToggle, timeAgo } from "@/components/sidebar";
import { studyApi as api, postJson } from "@/components/study/api";
import { Button } from "@/components/ui/button";
import { applyPicked, cardDocument, mcqCorrect, mcqSuggestedGrade } from "@/src/core";
import type { ChatListItem, StudyCardView, StudyCourseSummary, StudyGrade, StudyNextResult, StudyQueueCounts } from "@/src/core";

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

export function StudyView() {
	const [courses, setCourses] = useState<StudyCourseSummary[] | null>(null);
	const [lessons, setLessons] = useState<ChatListItem[]>([]);
	const [active, setActive] = useState<StudyCourseSummary | null>(null);
	const [error, setError] = useState<string | null>(null);

	const loadCourses = useCallback(async () => {
		try {
			const out = await api<{ courses: StudyCourseSummary[] }>("/api/study/courses");
			setCourses(out.courses);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
		// The lessons that belong to a course (Learnbox 2.0, Slice 9): a missing list only hides them.
		try {
			const out = await api<{ chats?: ChatListItem[] }>("/api/chats");
			setLessons((out.chats ?? []).filter((c) => c.courseId && (c.kind ?? "teach") === "teach"));
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

	return (
		<div className="flex h-dvh flex-col" data-testid="study-view">
			{active ? (
				<Session
					course={active}
					onExit={() => {
						setActive(null);
						void loadCourses();
					}}
				/>
			) : (
				<CoursePicker courses={courses} lessons={lessons} error={error} onPick={setActive} />
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

/** One course on the start screen: the course row (opens the review session) and, beneath it, the lessons that belong to it. */
function CourseCard({
	course: c,
	lessons,
	onPick,
}: {
	course: StudyCourseSummary;
	lessons: ChatListItem[];
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
		</div>
	);
}

function CoursePicker({
	courses,
	lessons,
	error,
	onPick,
}: {
	courses: StudyCourseSummary[] | null;
	/** The teaching sessions that belong to a course (from the sessions list). */
	lessons: ChatListItem[];
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
					<CourseCard key={c.id} course={c} lessons={lessons.filter((l) => l.courseId === c.id)} onPick={onPick} />
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

/** A throwaway nonce for one MCQ front; the card's own HTML is fixed before it exists, so it cannot know it. */
function newNonce(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function Session({ course, onExit }: { course: StudyCourseSummary; onExit: () => void }) {
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
		api<StudyNextResult>(`/api/study/next?course=${encodeURIComponent(course.id)}&step=0`)
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
	// answer is up. Z undo, S suspend, B bury until tomorrow, E edit.
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
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [state, revealed, editing, suggested, answer, undo, cardAction]);

	const tools = [
		{ id: "undo", label: "Undo (Z)", icon: Undo2Icon, run: undo, off: undoStack.length === 0 },
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

/**
 * The card in a sandboxed iframe: card HTML is deck content, never trusted. No scripts —
 * except an MCQ front, which runs our one fixed script (allowed by a nonce in its CSP, so
 * script tags inside the deck content stay dead) to report which options were clicked.
 */
function CardFrame({
	card,
	revealed,
	picked,
	onPick,
}: {
	card: StudyCardView;
	revealed: boolean;
	picked: readonly string[];
	onPick: (letters: string[]) => void;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
	const interactive = card.kind === "mcq" && !revealed;
	const nonce = useMemo(() => (interactive ? newNonce() : undefined), [interactive]);
	const srcDoc = useMemo(
		() =>
			cardDocument(revealed ? (card.kind === "mcq" ? applyPicked(card.back, picked) : card.back) : card.front, {
				dark,
				mcqNonce: nonce,
			}),
		[card, revealed, picked, dark, nonce],
	);

	// the sandboxed page reports its picks by postMessage — accept only this iframe, only letters A–D
	useEffect(() => {
		if (!interactive) return;
		const onMessage = (e: MessageEvent) => {
			if (e.source !== frame.current?.contentWindow) return;
			const letters = (e.data as { lhMcq?: unknown } | null)?.lhMcq;
			if (!Array.isArray(letters)) return;
			onPick(letters.filter((k): k is string => typeof k === "string" && /^[A-D]$/.test(k)));
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [interactive, onPick]);

	// A click inside the iframe moves keyboard focus into it, where the review shortcuts cannot
	// hear it — hand the focus straight back to the page.
	useEffect(() => {
		const reclaim = () => {
			setTimeout(() => {
				if (document.activeElement === frame.current) window.focus();
			}, 0);
		};
		window.addEventListener("blur", reclaim);
		return () => window.removeEventListener("blur", reclaim);
	}, []);

	return (
		<div className="min-h-0 flex-1" data-testid="study-card">
			<iframe
				ref={frame}
				title="Card"
				sandbox={interactive ? "allow-scripts" : ""}
				srcDoc={srcDoc}
				className="size-full border-0 bg-transparent"
				data-kind={card.kind}
				data-split={card.split}
			/>
		</div>
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
