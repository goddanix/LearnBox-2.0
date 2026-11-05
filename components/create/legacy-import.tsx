"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { studyApi as api, postJson } from "@/components/study/api";
import type { MigrateJob, MigrateResult, MigrateScan } from "@/src/core";

/** What the learner decides about one PDF job: whether it comes along and into which course ("" = none). */
interface Choice {
	take: boolean;
	courseId: string;
}

const control = "h-8 min-w-0 max-w-[11rem] rounded-md border bg-background px-2 text-sm text-foreground";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The first choices: every job that is not here yet, in the course MedAnki had it in. */
function firstChoices(jobs: readonly MigrateJob[]): Record<string, Choice> {
	const out: Record<string, Choice> = {};
	for (const j of jobs) if (!j.alreadyImported) out[j.id] = { take: true, courseId: j.courseId ?? "" };
	return out;
}

/** One line for what came over. */
function summary(r: MigrateResult): string[] {
	const lines: string[] = [];
	const parts = [
		r.courses > 0 && plural(r.courses, "subject"),
		r.jobs > 0 && `${plural(r.jobs, "PDF")} with ${plural(r.drafts, "card")}${r.linked > 0 ? ` (${r.linked} of them are study cards already)` : ""}`,
		r.mcq.imported > 0 && `${plural(r.mcq.imported, "multiple-choice test")} with ${plural(r.mcq.questions, "question")}`,
		r.notes > 0 && `the topic notes of ${plural(r.notes, "subject")}`,
		r.audio > 0 && plural(r.audio, "audio summary", "audio summaries"),
	].filter(Boolean);
	lines.push(parts.length > 0 ? `Brought over: ${parts.join(", ")}.` : "Nothing new to bring over.");
	if (r.vault === "set") lines.push("MedAnki's Obsidian vault is your vault now.");
	if (r.missingMedia > 0) lines.push(`${plural(r.missingMedia, "picture")} that MedAnki no longer had could not come along.`);
	if (r.audio > 0) lines.push("To make new audio, enter your ElevenLabs key in Settings → Keys.");
	return lines;
}

/**
 * Bring everything over from MedAnki: its subjects (as courses), PDF jobs with their cards and pictures, the topic notes and audio
 * summary of a subject, the Obsidian vault and the multiple-choice tests. "Check" is a dry run that lists what is there; "Import"
 * does it, with the PDF jobs and their courses as chosen here. MedAnki itself is only read. Nothing happens until Check is
 * pressed (the folder lives on the Desktop, which macOS guards).
 */
export function LegacyImport({ courses = [], onImported }: { courses?: readonly { id: string; name: string }[]; onImported: () => void }) {
	const [dir, setDir] = useState("");
	const [scan, setScan] = useState<MigrateScan | null>(null);
	const [choices, setChoices] = useState<Record<string, Choice>>({});
	const [done, setDone] = useState<MigrateResult | null>(null);
	const [busy, setBusy] = useState<"check" | "import" | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function run<T>(what: "check" | "import", body: object, then: (out: T) => void) {
		setBusy(what);
		setError(null);
		try {
			then(await api<T>("/api/create/migrate", postJson({ path: dir.trim() || undefined, ...body })));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	}

	// the courses a job can go into: MedAnki's subjects (made by the import) and the ones here
	const options: { id: string; name: string }[] = [];
	if (scan) {
		const own = new Set(courses.map((c) => c.name.toLowerCase()));
		for (const c of scan.courses) options.push({ id: c.id, name: !c.alreadyImported && own.has(c.name.toLowerCase()) ? `${c.name} (MedAnki)` : c.name });
		for (const c of courses) if (!options.some((o) => o.id === c.id)) options.push(c);
	}

	const chosen = scan?.jobs.filter((j) => choices[j.id]?.take) ?? [];
	const mcqWaiting = scan?.mcq.jobs.filter((j) => !j.alreadyImported) ?? [];
	const subjectsWaiting = scan?.courses.filter((c) => !c.alreadyImported || c.notes > 0 || c.audio) ?? [];
	const anything = chosen.length > 0 || mcqWaiting.length > 0 || subjectsWaiting.length > 0 || scan?.vault.willSet === true;
	const found = scan !== null && (scan.jobs.length > 0 || scan.courses.length > 0 || scan.mcq.jobs.length > 0);

	function setChoice(id: string, patch: Partial<Choice>) {
		setChoices((all) => ({ ...all, [id]: { ...(all[id] ?? { take: true, courseId: "" }), ...patch } }));
	}

	return (
		<details className="rounded-lg border" data-testid="legacy-import">
			<summary className="cursor-pointer px-4 py-3 text-xs uppercase tracking-widest text-muted-foreground/70">From MedAnki</summary>
			<div className="flex flex-col gap-3 px-4 pb-4">
				<p className="text-sm text-muted-foreground">
					Brings over what you made in MedAnki: your subjects, the PDFs with their cards, the topic notes, the audio summaries, the Obsidian vault and the multiple-choice tests. MedAnki itself is not changed.
				</p>
				<div className="flex gap-2">
					<Input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="Folder (default: ~/Desktop/CLAUDE/MedAnki/data)" aria-label="MedAnki data folder" />
					<Button
						variant="outline"
						size="sm"
						disabled={busy !== null}
						onClick={() =>
							void run<{ scan: MigrateScan }>("check", {}, (out) => {
								setScan(out.scan);
								setChoices(firstChoices(out.scan.jobs));
								setDone(null);
							})
						}
						data-testid="legacy-check"
					>
						{busy === "check" ? "Checking…" : "Check"}
					</Button>
				</div>
				{error && (
					<p className="text-sm text-red-400" role="alert">
						{error}
					</p>
				)}
				{scan && !found && <p className="text-sm text-muted-foreground">Nothing found there.</p>}

				{scan && scan.courses.length > 0 && (
					<section className="flex flex-col gap-1" data-testid="legacy-courses">
						<h3 className="text-xs uppercase tracking-widest text-muted-foreground/70">Subjects</h3>
						<ul className="flex flex-col gap-1 text-sm">
							{scan.courses.map((c) => (
								<li key={c.id} className="flex gap-2">
									<span className="min-w-0 flex-1 truncate">{c.name}</span>
									<span className="text-xs text-muted-foreground">
										{[c.alreadyImported ? "already here" : "new course", c.topics > 0 && plural(c.topics, "topic"), c.notes > 0 && "topic notes", c.audio && "audio summary"].filter(Boolean).join(" · ")}
									</span>
								</li>
							))}
						</ul>
					</section>
				)}

				{scan && scan.jobs.length > 0 && (
					<section className="flex flex-col gap-1" data-testid="legacy-pdfs">
						<h3 className="text-xs uppercase tracking-widest text-muted-foreground/70">PDFs with their cards</h3>
						<ul className="flex flex-col gap-1.5 text-sm">
							{scan.jobs.map((j) => (
								<li key={j.id} className="flex items-center gap-2" data-testid="legacy-pdf">
									<input
										type="checkbox"
										className="size-4"
										aria-label={`Bring over ${j.name}`}
										checked={choices[j.id]?.take ?? false}
										disabled={j.alreadyImported}
										onChange={(e) => setChoice(j.id, { take: e.target.checked })}
									/>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate">{j.name}</span>
										<span className="text-xs text-muted-foreground">
											{j.alreadyImported ? "already here" : `${plural(j.pages, "page")} · ${plural(j.cards, "card")}${j.linkable > 0 ? ` · ${j.linkable} already study cards` : ""}`}
										</span>
									</span>
									{!j.alreadyImported && (
										<select
											className={control}
											aria-label={`Course of ${j.name}`}
											value={choices[j.id]?.courseId ?? ""}
											disabled={!choices[j.id]?.take}
											onChange={(e) => setChoice(j.id, { courseId: e.target.value })}
										>
											<option value="">No course</option>
											{options.map((o) => (
												<option key={o.id} value={o.id}>
													{o.name}
												</option>
											))}
										</select>
									)}
								</li>
							))}
						</ul>
					</section>
				)}

				{scan && scan.mcq.jobs.length > 0 && (
					<section className="flex flex-col gap-1" data-testid="legacy-jobs">
						<h3 className="text-xs uppercase tracking-widest text-muted-foreground/70">Multiple-choice tests</h3>
						<ul className="flex flex-col gap-1 text-sm">
							{scan.mcq.jobs.map((j) => (
								<li key={j.id} className="flex gap-2">
									<span className="min-w-0 flex-1 truncate">{j.name}</span>
									<span className="text-xs text-muted-foreground">
										{j.alreadyImported ? "already here" : `${plural(j.questions, "question")}${j.linkable > 0 ? `, ${j.linkable} already cards` : ""}`}
									</span>
								</li>
							))}
						</ul>
					</section>
				)}

				{scan?.vault.medanki && (
					<p className="text-sm text-muted-foreground" data-testid="legacy-vault">
						{scan.vault.custom
							? `Your Obsidian vault (${scan.vault.current}) stays.`
							: scan.vault.medankiExists
								? `MedAnki's Obsidian vault (${scan.vault.medanki}) becomes your vault.`
								: `MedAnki's Obsidian vault is not at ${scan.vault.medanki} any more — you can choose one in Settings.`}
					</p>
				)}

				{scan && found && anything && (
					<div className="flex items-center gap-3">
						<Button
							size="sm"
							disabled={busy !== null}
							onClick={() =>
								void run<{ result: MigrateResult }>(
									"import",
									{ apply: true, jobs: (scan?.jobs ?? []).filter((j) => choices[j.id]?.take).map((j) => ({ id: j.id, courseId: choices[j.id]?.courseId || null })) },
									(out) => {
										setDone(out.result);
										setScan(null);
										onImported();
									},
								)
							}
							data-testid="legacy-import-button"
						>
							{busy === "import" ? "Importing…" : `Import (${plural(chosen.length, "PDF")})`}
						</Button>
						{busy === "import" && <span className="text-xs text-muted-foreground">This takes a minute — please keep this page open.</span>}
					</div>
				)}
				{done && (
					<div className="flex flex-col gap-0.5 text-sm text-emerald-400" role="status" data-testid="legacy-done">
						{summary(done).map((line) => (
							<p key={line}>{line}</p>
						))}
					</div>
				)}
			</div>
		</details>
	);
}
