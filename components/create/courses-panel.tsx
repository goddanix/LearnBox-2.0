"use client";

import { useState } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { studyApi as api, postJson } from "@/components/study/api";
import type { CreateCourse } from "@/src/core";

/**
 * The courses (MedAnki's Fächer) of the Create area: each has a list of topics that the PDFs made for it favour, and
 * collects the drafts of all its PDFs. Open one to set its topics, sort its drafts into them, and look for
 * duplicates across its PDFs; add a new one here (it is the same course the Study area learns).
 */
export function CoursesPanel({ courses, onOpen, onAdded }: { courses: CreateCourse[] | null; onOpen: (id: string) => void; onAdded: () => void }) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function add() {
		if (!name.trim()) return;
		setBusy(true);
		setError(null);
		try {
			await api("/api/study/courses", postJson({ name: name.trim() }));
			setName("");
			onAdded();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="flex flex-col gap-2" data-testid="courses-panel">
			<form
				className="flex items-end gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void add();
				}}
			>
				<label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">
					New course
					<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cardiology" maxLength={80} data-testid="course-new-name" />
				</label>
				<Button type="submit" size="sm" variant="outline" disabled={busy || !name.trim()} data-testid="course-add">
					<PlusIcon /> Add course
				</Button>
			</form>
			{error && (
				<p className="text-sm text-red-400" role="alert">
					{error}
				</p>
			)}
			{courses === null && <p className="text-sm text-muted-foreground">Loading…</p>}
			{courses?.length === 0 && (
				<p className="rounded-md border p-4 text-sm text-muted-foreground" data-testid="courses-empty">
					No courses yet. A course keeps the topics of a subject and the cards of all its lectures together.
				</p>
			)}
			{courses?.map((c) => (
				<button
					key={c.id}
					type="button"
					data-testid="course-row"
					onClick={() => onOpen(c.id)}
					className="flex flex-col gap-1 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-accent"
				>
					<span className="truncate text-base">{c.name}</span>
					<span className="text-xs text-muted-foreground">
						{c.topics.length === 0 ? "No topics yet" : `${c.topics.length} topic${c.topics.length === 1 ? "" : "s"}${c.strict ? " (only these)" : ""}`} · {c.jobs} PDF{c.jobs === 1 ? "" : "s"} · {c.drafts} draft{c.drafts === 1 ? "" : "s"}
						{c.deadline && ` · exam ${c.deadline}`}
					</span>
				</button>
			))}
		</section>
	);
}
