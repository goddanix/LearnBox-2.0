"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { studyApi as api, postJson } from "@/components/study/api";
import type { CardDensity, CardLatinMode, CardMaterialKind, CreateCourse, CreateJobSummary, CreateLanguage, LectureSource } from "@/src/core";

const DENSITIES: { value: CardDensity; label: string }[] = [
	{ value: "brief", label: "Brief — core facts only" },
	{ value: "normal", label: "Normal" },
	{ value: "thorough", label: "Thorough — important details too" },
	{ value: "concept", label: "Concept questions — understanding, few per PDF" },
];

const LANGUAGES: { value: CreateLanguage; label: string }[] = [
	{ value: "en", label: "English" },
	{ value: "de", label: "German" },
	{ value: "auto", label: "As the page" },
];

const LATIN: { value: CardLatinMode; label: string }[] = [
	{ value: "auto", label: "Automatic (by title)" },
	{ value: "on", label: "On" },
	{ value: "off", label: "Off" },
];

const KINDS: { value: CardMaterialKind; label: string }[] = [
	{ value: "lecture", label: "Lecture slides" },
	{ value: "practical", label: "Practical / lab course" },
];

const field = "flex flex-col gap-1 text-xs text-muted-foreground";
const control = "h-9 rounded-md border bg-background px-2 text-sm text-foreground";
const check = "flex items-center gap-2 text-sm text-foreground";

/** Settings for one flashcard job over a library PDF (MedAnki's card settings); "Create cards" makes the job and starts it. */
export function NewCardsForm({
	lecture,
	courses = [],
	onCreated,
	onCancel,
}: {
	lecture: LectureSource;
	/** The courses the PDF can be made for: choosing one makes its topics the focus (still editable here). */
	courses?: Pick<CreateCourse, "id" | "name" | "topics" | "strict">[];
	onCreated: (job: CreateJobSummary) => void;
	onCancel: () => void;
}) {
	const [courseId, setCourseId] = useState("");
	const [density, setDensity] = useState<CardDensity>("normal");
	const [language, setLanguage] = useState<CreateLanguage>("en");
	const [kind, setKind] = useState<CardMaterialKind>("lecture");
	const [latinTerms, setLatinTerms] = useState<CardLatinMode>("auto");
	const [from, setFrom] = useState(1);
	const [to, setTo] = useState(0);
	const [atlas, setAtlas] = useState(false);
	const [focus, setFocus] = useState("");
	const [focusStrict, setFocusStrict] = useState(false);
	const [focusOwn, setFocusOwn] = useState(false); // typed by the learner: choosing a course no longer replaces it
	const [vocab, setVocab] = useState(false);
	const [vocabLang, setVocabLang] = useState("Czech");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function chooseCourse(id: string) {
		setCourseId(id);
		const course = courses.find((c) => c.id === id);
		if (focusOwn) return;
		setFocus(course ? course.topics.join(", ") : "");
		setFocusStrict(course ? course.strict : false);
	}

	async function submit() {
		setBusy(true);
		setError(null);
		try {
			const out = await api<{ job: CreateJobSummary }>(
				"/api/create/jobs",
				postJson({
					kind: "cards",
					lectureId: lecture.id,
					...(courseId ? { courseId } : {}),
					settings: {
						density,
						language,
						kind,
						latinTerms,
						pageFrom: from,
						pageTo: to,
						wholeImageCards: atlas,
						focusTopics: focus,
						focusStrict,
						vocab,
						vocabLang,
					},
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
			data-testid="new-cards-form"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<h2 className="text-sm">
				Flashcards from <span className="font-medium">{lecture.title}</span>
			</h2>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
				<label className={`${field} col-span-2 sm:col-span-1`}>
					How many cards
					<select className={control} value={density} onChange={(e) => setDensity(e.target.value as CardDensity)}>
						{DENSITIES.map((d) => (
							<option key={d.value} value={d.value}>
								{d.label}
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
					Material
					<select className={control} value={kind} onChange={(e) => setKind(e.target.value as CardMaterialKind)}>
						{KINDS.map((k) => (
							<option key={k.value} value={k.value}>
								{k.label}
							</option>
						))}
					</select>
				</label>
				<label className={field}>
					From page
					<Input type="number" min={1} max={lecture.pages ?? undefined} value={from} onChange={(e) => setFrom(Number(e.target.value))} />
				</label>
				<label className={field}>
					To page (0 = end)
					<Input type="number" min={0} max={lecture.pages ?? undefined} value={to} onChange={(e) => setTo(Number(e.target.value))} />
				</label>
				<label className={field}>
					Latin terms (with English addition)
					<select className={control} value={latinTerms} onChange={(e) => setLatinTerms(e.target.value as CardLatinMode)}>
						{LATIN.map((l) => (
							<option key={l.value} value={l.value}>
								{l.label}
							</option>
						))}
					</select>
				</label>
			</div>

			{courses.length > 0 && (
				<label className={field}>
					Course (optional) — its topics become the focus
					<select className={control} value={courseId} onChange={(e) => chooseCourse(e.target.value)} data-testid="cards-course">
						<option value="">No course</option>
						{courses.map((c) => (
							<option key={c.id} value={c.id}>
								{c.name}
								{c.topics.length > 0 ? ` (${c.topics.length} topics)` : ""}
							</option>
						))}
					</select>
				</label>
			)}
			<label className={field}>
				Focus on topics (optional) — separated by commas
				<Input
					value={focus}
					onChange={(e) => {
						setFocus(e.target.value);
						setFocusOwn(true);
					}}
					placeholder="e.g. heart failure, troponin"
					data-testid="cards-focus"
				/>
			</label>
			{focus.trim() && (
				<label className={check}>
					<input type="checkbox" className="size-4" checked={focusStrict} onChange={(e) => setFocusStrict(e.target.checked)} />
					Only these topics (skip pages about anything else)
				</label>
			)}

			<label className={check}>
				<input type="checkbox" className="size-4" checked={atlas} onChange={(e) => setAtlas(e.target.checked)} data-testid="cards-atlas" />
				Atlas mode — one gap-text card per labelled figure instead of one card per label
			</label>
			<label className={check}>
				<input type="checkbox" className="size-4" checked={vocab} onChange={(e) => setVocab(e.target.checked)} data-testid="cards-vocab" />
				Vocabulary sheet of a language course — plain word pairs, at most 10 per page
			</label>
			{vocab && (
				<label className={field}>
					Course language
					<Input value={vocabLang} onChange={(e) => setVocabLang(e.target.value)} maxLength={40} />
				</label>
			)}

			{error && (
				<p className="text-sm text-red-400" role="alert">
					{error}
				</p>
			)}
			<div className="flex gap-2">
				<Button type="submit" size="sm" disabled={busy} data-testid="new-cards-submit">
					{busy ? "Starting…" : "Create cards"}
				</Button>
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
			</div>
			<p className="text-xs text-muted-foreground/70">
				Claude reads each page with your Claude sign-in and writes draft cards. Nothing is added to your cards until you adopt it.
			</p>
		</form>
	);
}
