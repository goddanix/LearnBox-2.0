"use client";

import { useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { describeUnsent } from "@/src/core";
import type { PhoneCatalogEntry } from "@/src/core";
import { PhoneCourseChoice } from "./phone-course-choice";
import { progressText } from "./phone-courses";
import type { PullProgress } from "./pull-deck";

/** Where the list of courses comes from: asked of the Mac just now, the last update's copy, or still being asked. */
export type LibraryListState = "loading" | "mac" | "phone";

/**
 * "On this phone": the Mac's courses with a box each. The ticked ones are what the phone holds; Update gets them, and
 * takes the unticked ones off the phone (answers the Mac does not have yet go to it first, so nothing is lost).
 */
export function PhoneLibrary({
	entries,
	held,
	listState,
	unsent,
	unsentOps,
	updating,
	error,
	online,
	onApply,
	onBack,
}: {
	/** Every course the Mac has (as far as the phone knows). */
	entries: readonly PhoneCatalogEntry[];
	/** The ids the phone holds now. */
	held: readonly string[];
	listState: LibraryListState;
	unsent: number;
	unsentOps: number;
	updating: PullProgress | null;
	error: string | null;
	online: boolean;
	onApply: (courseIds: string[]) => void;
	onBack: () => void;
}) {
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(held));
	const toggle = (id: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	const ids = entries.filter((e) => selected.has(e.id)).map((e) => e.id);
	const heldNow = entries.filter((e) => held.includes(e.id)).map((e) => e.id);
	const leaving = heldNow.filter((id) => !selected.has(id));
	const arriving = ids.filter((id) => !held.includes(id));
	const changed = leaving.length > 0 || arriving.length > 0;
	const busy = updating !== null;
	const ready = ids.length > 0 && !busy && online;
	const named = (list: readonly string[]) => list.map((id) => entries.find((e) => e.id === id)?.name ?? id).join(", ");
	return (
		<main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-3 px-4 pb-10 pt-2" data-testid="phone-library">
			<header className="flex items-center gap-1">
				<button type="button" onClick={onBack} aria-label="Back" className="flex size-11 items-center justify-center rounded-full text-muted-foreground active:bg-accent" data-testid="phone-library-back">
					<ArrowLeftIcon className="size-5" />
				</button>
				<h1 className="min-w-0 flex-1 text-center font-title text-xl">On this phone</h1>
				<span className="size-11" aria-hidden="true" />
			</header>
			<p className="text-sm text-muted-foreground">Tick the courses to keep on this phone. They work without a connection; the rest stay on your Mac.</p>
			{error && (
				<p className="rounded-md border border-red-500/40 p-3 text-sm text-red-400" role="alert" data-testid="phone-error">
					{error}
				</p>
			)}
			{entries.length === 0 ? (
				<p className="rounded-md border p-4 text-sm text-muted-foreground" data-testid="phone-library-empty">
					{listState === "loading" ? "Asking your Mac…" : "No courses to choose from yet. Import your cards on the Mac, then update."}
				</p>
			) : (
				<PhoneCourseChoice entries={entries} selected={selected} onToggle={toggle} disabled={busy} />
			)}
			<p className="text-xs text-muted-foreground" data-testid="phone-library-source">
				{listState === "mac" ? "List from your Mac, just now." : listState === "loading" ? "Asking your Mac for its list…" : "List from the last update (the Mac was not reached)."}
			</p>
			{ids.length === 0 && entries.length > 0 && (
				<p className="text-sm text-amber-500" data-testid="phone-library-none">
					Keep at least one course on the phone.
				</p>
			)}
			{leaving.length > 0 && (
				<p className="text-sm text-muted-foreground" data-testid="phone-library-leaving">
					Leaves this phone: {named(leaving)}. {unsent + unsentOps > 0 ? `${describeUnsent(unsent, unsentOps)} only on this phone go to the Mac first, so nothing is lost. ` : ""}It all stays on the Mac and can come back any time.
				</p>
			)}
			{arriving.length > 0 && (
				<p className="text-sm text-muted-foreground" data-testid="phone-library-arriving">
					Comes to this phone: {named(arriving)}.
				</p>
			)}
			{!online && (
				<p className="text-sm text-muted-foreground" data-testid="phone-library-offline">
					Changing this needs a connection to your Mac.
				</p>
			)}
			<button
				type="button"
				disabled={!ready}
				onClick={() => onApply(ids)}
				className="flex h-14 items-center justify-center rounded-xl bg-foreground text-base font-medium text-background disabled:opacity-50"
				data-testid="phone-library-apply"
			>
				{busy ? progressText(updating) : changed ? "Apply and update" : "Update now"}
			</button>
		</main>
	);
}
