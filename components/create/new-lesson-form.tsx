"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { studyApi as api, postJson } from "@/components/study/api";
import { LESSON_CARDS_PER_STATEMENT, withoutCards } from "@/src/core";
import type { CreateCourse, CreateJobSummary, CreateLanguage, LessonSource } from "@/src/core";

const LANGUAGES: { value: CreateLanguage; label: string }[] = [
	{ value: "en", label: "English" },
	{ value: "de", label: "German" },
];

const field = "flex flex-col gap-1 text-xs text-muted-foreground";
const control = "h-9 rounded-md border bg-background px-2 text-sm text-foreground";

/**
 * Flashcards from a lesson (or from nodes picked on the graph): the statements to make cards from — the ones that
 * have no card yet are ticked — and the course whose core knowledge the cards become. "Create cards" makes the job
 * and starts it; Claude writes up to three draft cards per statement, nothing reaches the cards until they are adopted.
 */
export function NewLessonForm({
	source,
	nodeIds,
	courses,
	onCreated,
	onCancel,
}: {
	source: LessonSource;
	/** The graph pick the statements came from (a lesson's statements are named by its chat instead). */
	nodeIds?: string[];
	courses: Pick<CreateCourse, "id" | "name">[];
	onCreated: (job: CreateJobSummary) => void;
	onCancel: () => void;
}) {
	const [ticked, setTicked] = useState<Set<string>>(() => new Set(withoutCards(source.statements)));
	// The lesson's course, else the only course there is; with several and no lesson course the learner chooses.
	const [courseId, setCourseId] = useState(() => (source.courseId && courses.some((c) => c.id === source.courseId) ? source.courseId : courses.length === 1 ? courses[0]!.id : ""));
	const [language, setLanguage] = useState<CreateLanguage>("en");
	const [perStatement, setPerStatement] = useState(LESSON_CARDS_PER_STATEMENT);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const toggle = (id: string, on: boolean) =>
		setTicked((prev) => {
			const next = new Set(prev);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});

	async function submit() {
		setBusy(true);
		setError(null);
		try {
			const out = await api<{ job: CreateJobSummary }>(
				"/api/create/jobs",
				postJson({
					kind: "lesson",
					...(source.chatId ? { chatId: source.chatId } : { nodeIds: nodeIds ?? source.statements.map((s) => s.nodeId) }),
					statementIds: source.statements.filter((s) => ticked.has(s.nodeId)).map((s) => s.nodeId),
					courseId,
					settings: { language, maxPerStatement: perStatement },
				}),
			);
			onCreated(out.job);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	}

	return (
		<form
			className="flex flex-col gap-3 rounded-lg border bg-card p-4"
			data-testid="new-lesson-form"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<h2 className="text-sm">
				Flashcards from <span className="font-medium">{source.title}</span>
			</h2>

			{source.statements.length === 0 ? (
				<p className="text-sm text-muted-foreground" data-testid="lesson-no-statements">
					This lesson has no statements yet. They appear once the lesson has been read into your knowledge graph.
				</p>
			) : (
				<fieldset className="flex flex-col gap-1.5" data-testid="lesson-statements">
					<legend className="mb-1 text-xs text-muted-foreground">
						Statements to make cards from — {ticked.size} of {source.statements.length} chosen
					</legend>
					{source.statements.map((s) => (
						<label key={s.nodeId} className="flex items-start gap-2 rounded-md border p-2 text-sm" data-testid="lesson-statement">
							<input
								type="checkbox"
								className="mt-1 size-4 shrink-0"
								checked={ticked.has(s.nodeId)}
								onChange={(e) => toggle(s.nodeId, e.target.checked)}
								aria-label={`Make cards from: ${s.name}`}
							/>
							<span className="min-w-0 flex-1">
								<span className="block text-xs text-muted-foreground">{s.name}</span>
								<span className="block">{s.statement}</span>
								{s.cards > 0 && (
									<span className="mt-0.5 block text-xs text-amber-400" data-testid="lesson-has-cards">
										Has {s.cards} card{s.cards === 1 ? "" : "s"} already — new ones will ask something else
									</span>
								)}
							</span>
						</label>
					))}
				</fieldset>
			)}

			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
				<label className={`${field} col-span-2 sm:col-span-1`}>
					Course (the cards become its core knowledge)
					<select className={control} value={courseId} onChange={(e) => setCourseId(e.target.value)} data-testid="lesson-course">
						<option value="" disabled>
							{courses.length === 0 ? "No course yet" : "Choose a course"}
						</option>
						{courses.map((c) => (
							<option key={c.id} value={c.id}>
								{c.name}
							</option>
						))}
					</select>
				</label>
				<label className={field}>
					Language
					<select className={control} value={language} onChange={(e) => setLanguage(e.target.value as CreateLanguage)}>
						{LANGUAGES.map((l) => (
							<option key={l.value} value={l.value}>
								{l.label}
							</option>
						))}
					</select>
				</label>
				<label className={field}>
					Cards per statement (at most)
					<select className={control} value={perStatement} onChange={(e) => setPerStatement(Number(e.target.value))}>
						{Array.from({ length: LESSON_CARDS_PER_STATEMENT }, (_, i) => i + 1).map((n) => (
							<option key={n} value={n}>
								{n}
							</option>
						))}
					</select>
				</label>
			</div>

			{error && (
				<p className="text-sm text-red-400" role="alert">
					{error}
				</p>
			)}
			<div className="flex gap-2">
				<Button type="submit" size="sm" disabled={busy || ticked.size === 0 || !courseId} data-testid="new-lesson-submit">
					{busy ? "Starting…" : "Create cards"}
				</Button>
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
			</div>
			<p className="text-xs text-muted-foreground/70">
				Claude reads each statement with your Claude sign-in and writes draft cards. Nothing is added to your cards until you adopt it.
			</p>
		</form>
	);
}
