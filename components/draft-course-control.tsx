"use client";

import { GraduationCapIcon } from "lucide-react";

/**
 * The draft's course field (Learnbox 2.0, 2026-11, Slice 9): a pill in the composer's action row that
 * assigns the new lesson to a study course. A lesson that comes from flashcards arrives with its
 * course set and a "N cards" mark (Clear drops the cards, the course stays). The created lesson
 * carries the course; the teacher hears about it, and about the cards, in a context message
 * before the first message.
 */
export function DraftCourseControl({
	courses,
	courseId,
	cardCount,
	onCourse,
	onClearCards,
}: {
	courses: ReadonlyArray<{ id: string; name: string }>;
	courseId: string;
	cardCount: number;
	onCourse: (id: string) => void;
	onClearCards?: () => void;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<label
				data-testid="draft-course"
				className={
					"flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors " +
					(courseId !== ""
						? "border-border bg-card text-foreground hover:bg-accent"
						: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")
				}
			>
				<GraduationCapIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				<select
					aria-label="Course"
					data-testid="draft-course-select"
					value={courseId}
					onChange={(e) => onCourse(e.target.value)}
					className="max-w-[14rem] cursor-pointer truncate bg-transparent text-xs outline-none"
				>
					<option value="">Add a course</option>
					{courses.map((c) => (
						<option key={c.id} value={c.id}>
							{c.name}
						</option>
					))}
				</select>
			</label>
			{cardCount > 0 && (
				<>
					<span data-testid="draft-cards" className="rounded-full border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground">
						{cardCount} {cardCount === 1 ? "card" : "cards"}
					</span>
					<button
						type="button"
						data-testid="draft-cards-clear"
						onClick={onClearCards}
						className="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						Clear
					</button>
				</>
			)}
		</div>
	);
}
