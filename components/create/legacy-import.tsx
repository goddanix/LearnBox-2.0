"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { studyApi as api, postJson } from "@/components/study/api";
import type { LegacyMcqImport, LegacyMcqScan } from "@/src/core";

/**
 * Bring MedAnki's multiple-choice jobs over: "Check" is a dry run that lists what
 * is there and how many questions already exist as cards; "Import" does it. The
 * MedAnki folder is only read. Nothing happens until Check is pressed (the folder
 * lives on the Desktop, which macOS guards).
 */
export function LegacyImport({ onImported }: { onImported: () => void }) {
	const [dir, setDir] = useState("");
	const [scan, setScan] = useState<LegacyMcqScan | null>(null);
	const [done, setDone] = useState<LegacyMcqImport | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function run<T>(body: object, then: (out: T) => void) {
		setBusy(true);
		setError(null);
		try {
			then(await api<T>("/api/create/legacy", postJson({ path: dir.trim() || undefined, ...body })));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	const waiting = scan?.jobs.filter((j) => !j.alreadyImported) ?? [];
	return (
		<details className="rounded-lg border" data-testid="legacy-import">
			<summary className="cursor-pointer px-4 py-3 text-xs uppercase tracking-widest text-muted-foreground/70">From MedAnki</summary>
			<div className="flex flex-col gap-3 px-4 pb-4">
				<p className="text-sm text-muted-foreground">
					Brings over the multiple-choice tests you made in MedAnki, with their PDFs. MedAnki itself is not changed.
				</p>
				<div className="flex gap-2">
					<Input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="Folder (default: ~/Desktop/CLAUDE/MedAnki/data)" aria-label="MedAnki data folder" />
					<Button
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() =>
							void run<{ scan: LegacyMcqScan }>({}, (out) => {
								setScan(out.scan);
								setDone(null);
							})
						}
						data-testid="legacy-check"
					>
						Check
					</Button>
				</div>
				{error && (
					<p className="text-sm text-red-400" role="alert">
						{error}
					</p>
				)}
				{scan && scan.jobs.length === 0 && <p className="text-sm text-muted-foreground">No multiple-choice jobs found there.</p>}
				{scan && scan.jobs.length > 0 && (
					<ul className="flex flex-col gap-1 text-sm" data-testid="legacy-jobs">
						{scan.jobs.map((j) => (
							<li key={j.id} className="flex gap-2">
								<span className="min-w-0 flex-1 truncate">{j.name}</span>
								<span className="text-xs text-muted-foreground">
									{j.alreadyImported ? "already here" : `${j.questions} questions${j.linkable > 0 ? `, ${j.linkable} already cards` : ""}`}
								</span>
							</li>
						))}
					</ul>
				)}
				{waiting.length > 0 && (
					<Button
						size="sm"
						className="self-start"
						disabled={busy}
						onClick={() =>
							void run<{ result: LegacyMcqImport }>({ apply: true }, (out) => {
								setDone(out.result);
								setScan(null);
								onImported();
							})
						}
						data-testid="legacy-import-button"
					>
						Import {waiting.length} job{waiting.length === 1 ? "" : "s"}
					</Button>
				)}
				{done && (
					<p className="text-sm text-emerald-400" role="status" data-testid="legacy-done">
						Imported {done.imported} job{done.imported === 1 ? "" : "s"} with {done.questions} questions
						{done.linked > 0 && ` (${done.linked} of them are already cards)`}.
					</p>
				)}
			</div>
		</details>
	);
}
