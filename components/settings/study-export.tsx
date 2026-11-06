"use client";
/**
 * Export to Anki: the chosen courses as an Anki package (.apkg).
 *
 * The learner picks the courses and two switches — "Include my learning progress" (off: every card arrives as a new
 * card; on: review history, due dates and memory values come along) and "Topics as sub-decks" — and the file is saved
 * through the browser's own download (in the desktop app: a Save dialog). Nothing in Anki is touched; they import the
 * file there themself (File → Import). The package is built on the server from the study ledgers (core/apkg.ts).
 */

import { useCallback, useEffect, useState } from "react";
import { postJson, studyApi } from "@/components/study/api";
import type { ApkgExportSummary, StudyCourseSummary } from "@/src/core";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

const fmtSize = (bytes: number) => (bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`);

/** The file name the route chose (`filename*=UTF-8''…`, else the plain `filename="…"`). */
function fileNameOf(header: string | null): string {
	const star = /filename\*=UTF-8''([^;]+)/i.exec(header ?? "");
	if (star) {
		try {
			return decodeURIComponent(star[1]!);
		} catch {
			// fall through to the plain name
		}
	}
	return /filename="([^"]+)"/i.exec(header ?? "")?.[1] ?? "Learnbox-export.apkg";
}

export function StudyExport() {
	const [courses, setCourses] = useState<StudyCourseSummary[] | null>(null);
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [progress, setProgress] = useState(false);
	const [subdecks, setSubdecks] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<{ name: string; summary: ApkgExportSummary } | null>(null);

	useEffect(() => {
		let cancelled = false;
		studyApi<{ courses: StudyCourseSummary[] }>("/api/study/courses")
			.then((r) => {
				if (cancelled) return;
				setCourses(r.courses);
				setChosen(new Set(r.courses.filter((c) => c.total > 0).map((c) => c.id)));
			})
			.catch(() => {
				if (!cancelled) setCourses([]);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const toggle = (id: string) =>
		setChosen((cur) => {
			const next = new Set(cur);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	const run = useCallback(async () => {
		setBusy(true);
		setError(null);
		setDone(null);
		try {
			const res = await fetch("/api/study/export", postJson({ courseIds: [...chosen], progress, subdecks }));
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? `Export failed (${res.status})`);
			}
			const raw = res.headers.get("x-learnbox-export");
			const summary = raw ? (JSON.parse(decodeURIComponent(raw)) as ApkgExportSummary) : null;
			const name = fileNameOf(res.headers.get("content-disposition"));
			const url = URL.createObjectURL(await res.blob());
			const link = document.createElement("a");
			link.href = url;
			link.download = name;
			document.body.append(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(url), 30_000);
			if (summary) setDone({ name, summary });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [chosen, progress, subdecks]);

	return (
		<SettingsGroup label="Export to Anki" testid="study-export">
			<p className="text-xs text-muted-foreground/80">
				Saves the chosen courses as an Anki package (.apkg) — one deck per course, on the MedAnki note types, with the
				pictures. Nothing in Anki is changed: you import the file there yourself (File → Import). Cards you originally
				imported from Anki would show up twice in the collection they came from, so import into a fresh profile.
			</p>

			<div className="flex flex-col gap-1" data-testid="export-courses">
				{courses === null && <span className="text-xs text-muted-foreground/70">Loading courses…</span>}
				{courses?.length === 0 && <span className="text-xs text-muted-foreground/70">No courses yet — nothing to export.</span>}
				{courses?.map((c) => (
					<label key={c.id} className="flex cursor-pointer items-center gap-2 text-xs">
						<input type="checkbox" checked={chosen.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Export ${c.name}`} />
						<span className="font-ui">{c.name}</span>
						<span className="text-muted-foreground/70">{c.total} cards</span>
					</label>
				))}
			</div>

			<SettingsRow
				label="Include my learning progress"
				hint={
					progress
						? "Review history, due dates and memory values come along. In Anki, tick “Include scheduling information” in the import dialog."
						: "Every card arrives as a new card."
				}
				testid="export-progress"
			>
				<Toggle checked={progress} onChange={setProgress} label="Include my learning progress" />
			</SettingsRow>
			<SettingsRow label="Topics as sub-decks" hint="Anatomie → Anatomie::Arm. Off: one deck per course." testid="export-subdecks">
				<Toggle checked={subdecks} onChange={setSubdecks} label="Topics as sub-decks" />
			</SettingsRow>

			<div className="flex items-center gap-3">
				<button
					type="button"
					data-testid="export-run"
					disabled={busy || chosen.size === 0}
					onClick={() => void run()}
					className="h-8 rounded-sm bg-foreground px-4 font-ui text-xs text-background transition-opacity hover:opacity-90 disabled:opacity-40"
				>
					{busy ? "Packing…" : `Export ${chosen.size} course${chosen.size === 1 ? "" : "s"}…`}
				</button>
			</div>

			{error && (
				<p role="alert" data-testid="export-error" className="rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500">
					{error}
				</p>
			)}
			{done && (
				<div className="rounded-sm border border-border px-3 py-2 text-xs" data-testid="export-result">
					<p>
						Saved {done.name} ({fmtSize(done.summary.bytes)}): {done.summary.cards} cards in {done.summary.notes} notes,{" "}
						{done.summary.decks} deck{done.summary.decks === 1 ? "" : "s"}
						{done.summary.reviews > 0 ? `, ${done.summary.reviews} reviews` : ""}, {done.summary.media} picture/audio file
						{done.summary.media === 1 ? "" : "s"}.
					</p>
					{done.summary.foldedNotes > 0 && (
						<p className="text-muted-foreground">
							{done.summary.foldedNotes} note{done.summary.foldedNotes === 1 ? "" : "s"} had extra fields; they were added to the Extra
							field.
						</p>
					)}
					{done.summary.missingCount > 0 && (
						<p className="text-amber-500">
							{done.summary.missingCount} media file{done.summary.missingCount === 1 ? "" : "s"} could not be found and are missing
							in the package: {done.summary.missingMedia.join(", ")}
							{done.summary.missingCount > done.summary.missingMedia.length ? ", …" : ""}.
						</p>
					)}
				</div>
			)}
		</SettingsGroup>
	);
}
