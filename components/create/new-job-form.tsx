"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { studyApi as api, postJson } from "@/components/study/api";
import type { CreateJobSummary, CreateLanguage, LectureSource } from "@/src/core";

const LANGUAGES: { value: CreateLanguage; label: string }[] = [
	{ value: "en", label: "English" },
	{ value: "de", label: "German" },
	{ value: "auto", label: "As the page" },
];

const field = "flex flex-col gap-1 text-xs text-muted-foreground";
const control = "h-9 rounded-md border bg-background px-2 text-sm text-foreground";

/** Settings for one MC-test job over a library PDF; "Create questions" makes the job and starts it. */
export function NewJobForm({
	lecture,
	lectures,
	onCreated,
	onCancel,
}: {
	lecture: LectureSource;
	lectures: LectureSource[];
	onCreated: (job: CreateJobSummary) => void;
	onCancel: () => void;
}) {
	const [perPage, setPerPage] = useState(4);
	const [language, setLanguage] = useState<CreateLanguage>("en");
	const [from, setFrom] = useState(1);
	const [to, setTo] = useState(0);
	const [sourceId, setSourceId] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const others = lectures.filter((l) => l.id !== lecture.id);

	async function submit() {
		setBusy(true);
		setError(null);
		try {
			const out = await api<{ job: CreateJobSummary }>(
				"/api/create/jobs",
				postJson({
					lectureId: lecture.id,
					sourceLectureId: sourceId || undefined,
					settings: { questionsPerPage: perPage, language, pageFrom: from, pageTo: to },
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
			data-testid="new-job-form"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<h2 className="text-sm">
				Multiple-choice test from <span className="font-medium">{lecture.title}</span>
			</h2>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<label className={field}>
					Questions per page
					<Input type="number" min={1} max={10} value={perPage} onChange={(e) => setPerPage(Number(e.target.value))} />
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
					From page
					<Input type="number" min={1} max={lecture.pages ?? undefined} value={from} onChange={(e) => setFrom(Number(e.target.value))} />
				</label>
				<label className={field}>
					To page (0 = end)
					<Input type="number" min={0} max={lecture.pages ?? undefined} value={to} onChange={(e) => setTo(Number(e.target.value))} />
				</label>
			</div>
			{others.length > 0 && (
				<label className={field}>
					Facts from another PDF (optional) — e.g. the lecture slides behind a question sheet
					<select className={control} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
						<option value="">None</option>
						{others.map((l) => (
							<option key={l.id} value={l.id}>
								{l.title}
							</option>
						))}
					</select>
				</label>
			)}
			{error && (
				<p className="text-sm text-red-400" role="alert">
					{error}
				</p>
			)}
			<div className="flex gap-2">
				<Button type="submit" size="sm" disabled={busy} data-testid="new-job-submit">
					{busy ? "Starting…" : "Create questions"}
				</Button>
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
			</div>
			<p className="text-xs text-muted-foreground/70">
				Claude reads each page with your Claude sign-in and writes drafts. Nothing is added to your cards until you adopt it.
			</p>
		</form>
	);
}
