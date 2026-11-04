"use client";
/**
 * The Study section: bring an existing Anki collection into the study ledgers.
 *
 * Flow (owner-approved 2026-11-04): pick a collection found under Anki's data
 * folder (or type a path) → "Read" shows its decks with a suggested plan → the
 * owner edits courses (name, deadline, buffer, new/day — pre-filled from the
 * Deadline Scheduler) and maps every deck to a course or skips it → "Import".
 * The server reads a COPY of the collection; Anki stays untouched and may run.
 * Re-importing is safe: what exists is skipped.
 */

import { useCallback, useEffect, useState } from "react";
import { postJson, studyApi } from "@/components/study/api";
import type {
	AnkiCandidate,
	ImportOutcome,
	ImportPlan,
	InspectResult,
	StudyCourse,
} from "@/src/core";
import { CommitInput, SettingsGroup, ThinSelect } from "./controls.tsx";

const SKIP = "__skip__";
/** Window event: the study ledgers changed (an import ran). */
export const STUDY_CHANGED = "lh:study-changed";

const fmtSize = (bytes: number) => `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;

export function StudySection() {
	const [candidates, setCandidates] = useState<AnkiCandidate[] | null>(null);
	const [path, setPath] = useState("");
	const [inspect, setInspect] = useState<InspectResult | null>(null);
	const [courses, setCourses] = useState<StudyCourse[]>([]);
	const [decks, setDecks] = useState<ImportPlan["decks"]>({});
	const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		studyApi<{ collections: AnkiCandidate[] }>("/api/study/anki")
			.then((r) => {
				if (cancelled) return;
				setCandidates(r.collections);
				setPath((cur) => cur || r.collections[0]?.path || "");
			})
			.catch(() => {
				if (!cancelled) setCandidates([]);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const read = useCallback(async () => {
		setBusy(true);
		setError(null);
		setOutcome(null);
		try {
			const r = await studyApi<InspectResult>("/api/study/anki/inspect", postJson({ path }));
			setInspect(r);
			setCourses(r.suggestedPlan.courses);
			setDecks(r.suggestedPlan.decks);
		} catch (e) {
			setInspect(null);
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [path]);

	const existing = new Set(inspect?.existingCourses.map((c) => c.id));
	const importable = Object.values(decks).filter(Boolean).length;

	const doImport = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			// a suggested course no deck points at is simply not created
			const used = new Set(Object.values(decks).flatMap((t) => (t ? [t.courseId] : [])));
			const plan: ImportPlan = { courses: courses.filter((c) => used.has(c.id)), decks };
			setOutcome(await studyApi<ImportOutcome>("/api/study/anki/import", postJson({ path, plan })));
			// the course list behind this dialog refreshes itself
			window.dispatchEvent(new Event(STUDY_CHANGED));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [courses, decks, path]);

	const patchCourse = (id: string, patch: Partial<StudyCourse>) =>
		setCourses((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));

	const patchDeck = (deckId: string, target: string, topic?: string) =>
		setDecks((d) => {
			if (target === SKIP) return { ...d, [deckId]: null };
			const prev = d[deckId];
			const nextTopic = topic ?? prev?.topic;
			return { ...d, [deckId]: nextTopic ? { courseId: target, topic: nextTopic } : { courseId: target } };
		});

	const inputCls =
		"h-7 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none disabled:opacity-40";

	return (
		<div className="flex flex-col gap-5" data-testid="study-settings">
			<SettingsGroup label="Import from Anki" testid="study-import">
				<p className="text-xs text-muted-foreground/80">
					Reads a copy of your collection — Anki can stay open and nothing in Anki is changed. Cards, review history and
					media come along; importing again skips what is already here.
				</p>

				<div className="flex flex-col gap-1" data-testid="anki-candidates">
					{candidates === null && <span className="text-xs text-muted-foreground/70">Looking for Anki…</span>}
					{candidates?.length === 0 && (
						<span className="text-xs text-muted-foreground/70">
							No collection found in ~/Library/Application Support/Anki2 — enter a path below.
						</span>
					)}
					{candidates?.map((c) => (
						<label key={c.path} className="flex cursor-pointer items-center gap-2 text-xs">
							<input type="radio" name="anki-collection" checked={path === c.path} onChange={() => setPath(c.path)} />
							<span className="font-ui">{c.profile}</span>
							<span className="text-muted-foreground/70">
								{fmtSize(c.sizeBytes)} · changed {new Date(c.modified).toLocaleDateString()}
							</span>
						</label>
					))}
				</div>

				<div className="flex items-center gap-2">
					<CommitInput
						value={candidates?.some((c) => c.path === path) ? "" : path}
						placeholder="…or a path to a collection.anki2"
						ariaLabel="Path to an Anki collection"
						testid="anki-path"
						onCommit={(v) => setPath(v)}
					/>
					<button
						type="button"
						data-testid="anki-read"
						disabled={busy || path === ""}
						onClick={() => void read()}
						className="h-7 rounded-sm border border-border px-3 font-ui text-xs transition-colors hover:bg-accent disabled:opacity-40"
					>
						{busy && !inspect ? "Reading…" : "Read collection"}
					</button>
				</div>

				{error && (
					<p role="alert" data-testid="anki-error" className="rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500">
						{error}
					</p>
				)}
			</SettingsGroup>

			{inspect && (
				<>
					<p className="text-xs text-muted-foreground" data-testid="anki-summary">
						{inspect.inspection.decks.length} decks · {inspect.inspection.cards} cards · {inspect.inspection.reviews} reviews
						{inspect.inspection.noteTypes.some((t) => !t.supported) &&
							` · skipped note types: ${inspect.inspection.noteTypes
								.filter((t) => !t.supported)
								.map((t) => `${t.name} (${t.notes})`)
								.join(", ")}`}
					</p>
					{inspect.suggestedPlan.hints.map((h) => (
						<p key={h} className="text-xs text-amber-500">
							{h}
						</p>
					))}

					<SettingsGroup label="Courses" testid="study-courses">
						{courses.map((c) => {
							const exists = existing.has(c.id);
							return (
								<div key={c.id} data-testid="plan-course" className="flex flex-wrap items-center gap-2 py-1">
									<span className="w-36 shrink-0">
										<CommitInput
											value={c.name}
											ariaLabel={`Name of ${c.name}`}
											onCommit={(v) => patchCourse(c.id, { name: v })}
										/>
									</span>
									{exists ? (
										<span className="text-xs text-muted-foreground/70">already exists — kept as is</span>
									) : (
										<>
											<label className="flex items-center gap-1 text-xs text-muted-foreground">
												Exam
												<input
													type="date"
													aria-label={`Deadline of ${c.name}`}
													value={c.deadline ?? ""}
													onChange={(e) => patchCourse(c.id, { deadline: e.target.value || undefined })}
													className={inputCls}
												/>
											</label>
											<label className="flex items-center gap-1 text-xs text-muted-foreground">
												Buffer
												<input
													type="number"
													min={0}
													max={60}
													aria-label={`Buffer days of ${c.name}`}
													value={c.bufferDays}
													onChange={(e) => patchCourse(c.id, { bufferDays: Number(e.target.value) })}
													className={`${inputCls} w-14`}
												/>
												d
											</label>
											<label className="flex items-center gap-1 text-xs text-muted-foreground">
												New/day
												<input
													type="number"
													min={1}
													aria-label={`New cards per day of ${c.name}`}
													placeholder="auto"
													value={c.newPerDay ?? ""}
													onChange={(e) =>
														patchCourse(c.id, { newPerDay: e.target.value === "" ? undefined : Number(e.target.value) })
													}
													className={`${inputCls} w-16`}
												/>
											</label>
										</>
									)}
								</div>
							);
						})}
					</SettingsGroup>

					<SettingsGroup label="Decks" testid="study-decks">
						{inspect.inspection.decks.map((d) => {
							const target = decks[String(d.id)];
							return (
								<div key={d.id} data-testid="plan-deck" className="flex flex-wrap items-center gap-2 py-1">
									<span className="min-w-0 flex-1 truncate font-ui text-xs" title={d.name}>
										{d.name}
									</span>
									<span className="w-16 text-right text-xs tabular-nums text-muted-foreground/70">{d.cards} cards</span>
									<ThinSelect
										value={target?.courseId ?? SKIP}
										ariaLabel={`Course for ${d.name}`}
										onChange={(v) => patchDeck(String(d.id), v)}
									>
										{courses.map((c) => (
											<option key={c.id} value={c.id}>
												{c.name}
												{existing.has(c.id) ? " (existing)" : ""}
											</option>
										))}
										{inspect.existingCourses
											.filter((e) => !courses.some((c) => c.id === e.id))
											.map((e) => (
												<option key={e.id} value={e.id}>
													{e.name} (existing)
												</option>
											))}
										<option value={SKIP}>Skip this deck</option>
									</ThinSelect>
									<CommitInput
										value={target?.topic ?? ""}
										placeholder="topic"
										ariaLabel={`Topic for ${d.name}`}
										onCommit={(v) => target && patchDeck(String(d.id), target.courseId, v)}
									/>
								</div>
							);
						})}
					</SettingsGroup>

					<div className="flex items-center gap-3">
						<button
							type="button"
							data-testid="anki-import"
							disabled={busy || importable === 0}
							onClick={() => void doImport()}
							className="h-8 rounded-sm bg-foreground px-4 font-ui text-xs text-background transition-opacity hover:opacity-90 disabled:opacity-40"
						>
							{busy ? "Importing…" : `Import ${importable} deck${importable === 1 ? "" : "s"}`}
						</button>
					</div>
				</>
			)}

			{outcome && <ImportResult outcome={outcome} />}
		</div>
	);
}

function ImportResult({ outcome }: { outcome: ImportOutcome }) {
	const { added, alreadyImported, media, report } = outcome;
	const skipped = report.skippedCards;
	const unsupported = Object.entries(skipped.unsupportedNoteType);
	return (
		<div className="rounded-sm border border-border px-3 py-2 text-xs" data-testid="anki-result">
			<p>
				Imported {added.cards} cards, {added.reviews} reviews, {added.courses} new course{added.courses === 1 ? "" : "s"}.
				You will find them under Study.
			</p>
			{(alreadyImported.cards > 0 || alreadyImported.reviews > 0) && (
				<p className="text-muted-foreground">
					Already here, left alone: {alreadyImported.cards} cards, {alreadyImported.reviews} reviews.
				</p>
			)}
			{skipped.unmappedDeck > 0 && <p className="text-muted-foreground">Skipped decks: {skipped.unmappedDeck} cards.</p>}
			{unsupported.length > 0 && (
				<p className="text-muted-foreground">
					Skipped note types: {unsupported.map(([name, n]) => `${name} (${n})`).join(", ")}.
				</p>
			)}
			{Object.keys(report.remapped).length > 0 && (
				<p className="text-muted-foreground">
					Mapped by structure: {Object.entries(report.remapped).map(([name, n]) => `${name} (${n})`).join(", ")}.
				</p>
			)}
			<p className="text-muted-foreground">
				Media: {media.copied.length} copied{media.existing.length > 0 ? `, ${media.existing.length} already here` : ""}
				{media.missing.length > 0 ? `, ${media.missing.length} missing in Anki's media folder` : ""}.
			</p>
		</div>
	);
}
