"use client";

import type { PhoneCatalogEntry } from "@/src/core";
import { formatBytes } from "./phone-storage";

/** "3 courses · 1289 cards · 38 MB of pictures and sounds" for the courses ticked. */
export function choiceTotal(entries: readonly PhoneCatalogEntry[], selected: ReadonlySet<string>): string {
	const chosen = entries.filter((e) => selected.has(e.id));
	const cards = chosen.reduce((sum, e) => sum + e.cards, 0);
	const bytes = chosen.reduce((sum, e) => sum + e.mediaBytes, 0);
	const parts = [`${chosen.length} course${chosen.length === 1 ? "" : "s"}`, `${cards} card${cards === 1 ? "" : "s"}`];
	if (bytes > 0) parts.push(`${formatBytes(bytes)} of pictures and sounds`);
	return parts.join(" · ");
}

/**
 * The Mac's courses with a box each: what goes on this phone. Shared by the first run and the library screen.
 */
export function PhoneCourseChoice({
	entries,
	selected,
	onToggle,
	disabled = false,
}: {
	entries: readonly PhoneCatalogEntry[];
	selected: ReadonlySet<string>;
	onToggle: (id: string) => void;
	disabled?: boolean;
}) {
	return (
		<div className="flex flex-col gap-2" data-testid="phone-choice">
			<ul className="flex flex-col overflow-hidden rounded-xl border bg-card">
				{entries.map((e) => (
					<li key={e.id} className="border-b last:border-b-0">
						<label className="flex min-h-14 cursor-pointer items-center gap-3 px-4 py-2 active:bg-accent">
							<input
								type="checkbox"
								className="size-5 shrink-0 accent-sky-500"
								checked={selected.has(e.id)}
								disabled={disabled}
								onChange={() => onToggle(e.id)}
								data-testid="phone-choice-item"
								data-course={e.id}
							/>
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate text-base">{e.name}</span>
								<span className="text-xs text-muted-foreground">
									{e.cards} card{e.cards === 1 ? "" : "s"}
									{e.mediaBytes > 0 && ` · ${formatBytes(e.mediaBytes)}`}
								</span>
							</span>
						</label>
					</li>
				))}
			</ul>
			<p className="text-xs text-muted-foreground" data-testid="phone-choice-total">
				{choiceTotal(entries, selected)}
			</p>
		</div>
	);
}
