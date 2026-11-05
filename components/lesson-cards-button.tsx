"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LayersIcon } from "lucide-react";
import type { LessonSource } from "@/src/core";

/**
 * "Make cards" in a lesson's header (Learnbox 2.0, 2026-11, Slice 9c): opens Create's form for flashcards from the
 * statements this lesson established. The statements are the propositions the lesson touched in the knowledge graph,
 * so a lesson that has not been read into the graph yet has none — then the button stays grey and says why. The
 * count is asked again whenever `refreshKey` changes (a turn went by; the graph may have grown).
 */
export function LessonCardsButton({ chatId, refreshKey }: { chatId: string; refreshKey?: number }) {
	const [count, setCount] = useState<number | null>(null);

	useEffect(() => {
		let live = true;
		void fetch(`/api/create/lesson-source?chat=${encodeURIComponent(chatId)}`)
			.then((r) => (r.ok ? (r.json() as Promise<LessonSource>) : null))
			.then((source) => {
				if (live) setCount(source ? source.statements.length : null);
			})
			.catch(() => {
				if (live) setCount(null);
			});
		return () => {
			live = false;
		};
	}, [chatId, refreshKey]);

	if (count === null) return null;
	const base = "lh-no-drag flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium tracking-wide transition-colors";
	if (count === 0) {
		return (
			<span
				data-testid="lesson-cards-button"
				aria-disabled="true"
				title="No statements yet — they appear once this lesson has been read into your knowledge graph"
				className={`${base} cursor-not-allowed border-dashed border-border/60 text-muted-foreground/60`}
			>
				<LayersIcon aria-hidden="true" className="size-3.5" />
				Make cards
			</span>
		);
	}
	return (
		<Link
			href={`/create?lesson=${encodeURIComponent(chatId)}`}
			data-testid="lesson-cards-button"
			title={`Make flashcards from the ${count} statement${count === 1 ? "" : "s"} of this lesson`}
			className={`${base} border-border/80 text-foreground hover:border-border hover:bg-accent`}
		>
			<LayersIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
			Make cards
		</Link>
	);
}
