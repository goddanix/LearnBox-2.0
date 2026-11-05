"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { studyApi as api, postJson } from "@/components/study/api";
import { CardBody } from "@/components/create/draft-card";
import type { CardDraft, CourseDuplicateGroup, CourseDuplicateReview, CourseSemanticStep, DuplicateGroup, DuplicateReview, SemanticStep } from "@/src/core";

const STRICTNESS = [
	{ value: 0.9, label: "Strict — nearly the same wording" },
	{ value: 0.8, label: "Normal" },
	{ value: 0.6, label: "Loose — also similar questions" },
];

/** Where the duplicates are looked for: the drafts of one PDF's job, or of all PDFs of a course. */
export type DuplicatesScope = { jobId: string } | { courseId: string };

type Review = (DuplicateReview & { semantic: DuplicateGroup[] }) | CourseDuplicateReview;

/** A group as the panel shows it, whichever scope it comes from: cards are named by `ref` (a draft id, or "jobId|cardId" across PDFs). */
interface ViewGroup {
	id: string;
	semantic: boolean;
	reason: string;
	keep: string;
	cards: { ref: string; jobId: string; where: string; card: CardDraft }[];
}

const jobMedia = (jobId: string) => (file: string) => `/api/create/jobs/${jobId}/media/${encodeURIComponent(file)}`;

function viewGroup(g: DuplicateGroup | CourseDuplicateGroup, jobId: string | null): ViewGroup {
	const cards = g.cards.map((c) =>
		"ref" in c
			? { ref: c.ref, jobId: c.jobId, where: `${c.jobName} · page ${c.card.page}`, card: c.card }
			: { ref: c.id, jobId: jobId ?? "", where: `Page ${c.page}`, card: c },
	);
	return { id: g.id, semantic: g.semantic === true, reason: g.reason, keep: g.keep, cards };
}

/**
 * Cards of the job (or of all PDFs of a course) that ask for the same thing: the quick comparison first, and — on
 * request — Claude's check of the content (the same question worded differently, one label at another place of a
 * figure). Nothing is removed without the learner clicking; a removed card can be brought back from its page.
 */
export function DuplicatesPanel({ scope, onChanged }: { scope: DuplicatesScope; onChanged: () => void }) {
	const jobId = "jobId" in scope ? scope.jobId : null;
	const base = "jobId" in scope ? `/api/create/jobs/${scope.jobId}` : `/api/create/courses/${scope.courseId}`;
	const [threshold, setThreshold] = useState(0.8);
	const [review, setReview] = useState<Review | null>(null);
	const [keep, setKeep] = useState<Record<string, string>>({});
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);
	const stop = useRef(false);

	const load = useCallback(async () => {
		try {
			setReview(await api<Review>(`${base}/duplicates?threshold=${threshold}`));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [base, threshold]);
	useEffect(() => {
		void load();
	}, [load]);

	const groups: ViewGroup[] = review ? [...review.groups, ...review.semantic].map((g) => viewGroup(g, jobId)) : [];
	const keeperOf = (g: ViewGroup) => (g.cards.some((c) => c.ref === keep[g.id]) ? keep[g.id]! : g.keep);

	async function remove(chosen: ViewGroup[]) {
		setBusy(true);
		setError(null);
		try {
			const body = { groups: chosen.map((g) => ({ keep: keeperOf(g), remove: g.cards.map((c) => c.ref).filter((ref) => ref !== keeperOf(g)) })) };
			await api(`${base}/duplicates`, postJson(body));
			await load();
			onChanged();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	async function check() {
		setChecking(true);
		setError(null);
		stop.current = false;
		try {
			for (;;) {
				const step = await api<SemanticStep | CourseSemanticStep>(`${base}/duplicates/check`, postJson({ threshold }));
				setProgress(step.done ? null : `Claude checked ${step.checkedNow} cards, ${step.remaining} pairs left…`);
				if (step.error) {
					setError(`Claude's check stopped: ${step.error}`);
					break;
				}
				if (step.done || step.checkedNow === 0 || stop.current) break;
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setChecking(false);
			setProgress(null);
			await load();
		}
	}

	return (
		<section className="flex flex-col gap-3 rounded-lg border bg-card p-3" data-testid="duplicates-panel">
			<div className="flex flex-wrap items-end gap-2">
				<h3 className="mr-auto text-sm font-medium">{jobId ? "Duplicate cards" : "Duplicate cards across the PDFs of this course"}</h3>
				<label className="flex flex-col gap-1 text-xs text-muted-foreground">
					How alike
					<select className="h-8 rounded-md border bg-background px-2 text-sm text-foreground" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
						{STRICTNESS.map((s) => (
							<option key={s.value} value={s.value}>
								{s.label}
							</option>
						))}
					</select>
				</label>
				{checking ? (
					<Button size="sm" variant="outline" onClick={() => (stop.current = true)}>
						Stop checking
					</Button>
				) : (
					<Button size="sm" variant="outline" onClick={() => void check()} data-testid="dedupe-check" title="Claude reads the cards and finds the ones that ask for the same thing in other words">
						Check with Claude
					</Button>
				)}
			</div>
			{progress && <p className="text-xs text-muted-foreground">{progress}</p>}
			{review && review.autoRemoved > 0 && <p className="text-xs text-muted-foreground">{review.autoRemoved} almost identical card{review.autoRemoved === 1 ? " was" : "s were"} removed automatically — bring them back from their page if you want them.</p>}
			{error && (
				<p className="text-sm text-red-400" role="alert">
					{error}
				</p>
			)}
			{review && groups.length === 0 && <p className="text-sm text-muted-foreground">No duplicates found{threshold < 0.8 ? "" : " — try “Loose”, or check with Claude"}.</p>}
			{groups.length > 1 && (
				<Button size="sm" className="self-start" disabled={busy} onClick={() => void remove(groups)}>
					Keep the marked card of every group ({groups.length})
				</Button>
			)}
			<ul className="flex flex-col gap-3">
				{groups.map((g) => (
					<li key={g.id} className="rounded-md border p-2" data-testid="dup-group">
						<div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
							<span>{g.semantic ? "Same concept (checked by Claude)" : g.reason === "identical" ? "Identical" : g.reason}</span>
							<Button size="xs" variant="outline" className="ml-auto" disabled={busy} onClick={() => void remove([g])}>
								Remove the others
							</Button>
						</div>
						<ul className="flex flex-col gap-2">
							{g.cards.map((c) => (
								<li key={c.ref} className="flex items-start gap-2 rounded border p-2 text-sm">
									<input type="radio" className="mt-1" name={`keep-${g.id}`} checked={keeperOf(g) === c.ref} onChange={() => setKeep((prev) => ({ ...prev, [g.id]: c.ref }))} aria-label="Keep this card" />
									<div className="min-w-0 flex-1">
										<p className="mb-0.5 text-xs text-muted-foreground">{c.where}</p>
										<CardBody c={c.card} mediaUrl={jobMedia(c.jobId)} />
									</div>
								</li>
							))}
						</ul>
					</li>
				))}
			</ul>
		</section>
	);
}
