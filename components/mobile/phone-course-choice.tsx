"use client";

import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import type { PhoneCatalogEntry } from "@/src/core";
import { choiceTotal, courseLine, courseTicks, NO_SUBDECK_LABEL, subdecksOf, topicTicked } from "./phone-choice";
import type { PhoneChoice } from "./phone-choice";
import { formatBytes } from "./phone-storage";

/**
 * The Mac's courses with a box each, and under a course that has subdecks a list of them with a box each: what goes on
 * this phone. Shared by the first run and the library screen.
 */
export function PhoneCourseChoice({
	entries,
	choice,
	onToggleCourse,
	onToggleTopic,
	disabled = false,
}: {
	entries: readonly PhoneCatalogEntry[];
	choice: PhoneChoice;
	onToggleCourse: (entry: PhoneCatalogEntry) => void;
	onToggleTopic: (entry: PhoneCatalogEntry, name: string) => void;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
	const flip = (id: string) =>
		setOpen((prev) => {
			const next = new Set(prev);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	return (
		<div className="flex flex-col gap-2" data-testid="phone-choice">
			<ul className="flex flex-col overflow-hidden rounded-xl border bg-card">
				{entries.map((e) => {
					const subs = subdecksOf(e);
					const ticks = courseTicks(e, choice);
					const expanded = subs !== null && open.has(e.id);
					return (
						<li key={e.id} className="border-b last:border-b-0">
							<div className="flex items-stretch">
								<label className="flex min-h-14 min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-2 active:bg-accent">
									<input
										type="checkbox"
										className="size-5 shrink-0 accent-sky-500"
										checked={ticks !== "none"}
										ref={(el) => {
											if (el) el.indeterminate = ticks === "some";
										}}
										disabled={disabled}
										onChange={() => onToggleCourse(e)}
										data-testid="phone-choice-item"
										data-course={e.id}
										data-ticks={ticks}
									/>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate text-base">{e.name}</span>
										<span className="text-xs text-muted-foreground" data-testid="phone-choice-line" data-course={e.id}>
											{courseLine(e, choice)}
										</span>
									</span>
								</label>
								{subs && (
									<button
										type="button"
										onClick={() => flip(e.id)}
										aria-expanded={expanded}
										aria-label={`Subdecks of ${e.name}`}
										className="flex w-12 shrink-0 items-center justify-center text-muted-foreground active:bg-accent"
										data-testid="phone-choice-expand"
										data-course={e.id}
									>
										<ChevronDownIcon className={`size-5 transition-transform ${expanded ? "rotate-180" : ""}`} />
									</button>
								)}
							</div>
							{subs && expanded && (
								<ul className="flex flex-col border-t bg-background/40" data-testid="phone-choice-topics" data-course={e.id}>
									{subs.map((t) => (
										<li key={t.name} className="border-b last:border-b-0">
											<label className="flex min-h-12 cursor-pointer items-center gap-3 py-2 pl-8 pr-4 active:bg-accent">
												<input
													type="checkbox"
													className="size-5 shrink-0 accent-sky-500"
													checked={topicTicked(e, choice, t.name)}
													disabled={disabled}
													onChange={() => onToggleTopic(e, t.name)}
													data-testid="phone-choice-topic"
													data-course={e.id}
													data-topic={t.name}
												/>
												<span className="flex min-w-0 flex-1 flex-col">
													<span className={`truncate text-sm ${t.name === "" ? "italic text-muted-foreground" : ""}`}>{t.name === "" ? NO_SUBDECK_LABEL : t.name}</span>
													<span className="text-xs text-muted-foreground">
														{t.cards} card{t.cards === 1 ? "" : "s"}
														{t.mediaBytes > 0 && ` · ${formatBytes(t.mediaBytes)}`}
													</span>
												</span>
											</label>
										</li>
									))}
								</ul>
							)}
						</li>
					);
				})}
			</ul>
			<p className="text-xs text-muted-foreground" data-testid="phone-choice-total">
				{choiceTotal(entries, choice)}
			</p>
		</div>
	);
}
