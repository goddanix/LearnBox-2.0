"use client";

import { useEffect, useState } from "react";
import { GraduationCapIcon } from "lucide-react";

/**
 * The lesson's course (Learnbox 2.0, 2026-11, Slice 9): a quiet select in the session header that
 * assigns the lesson to a study course (Fach) or takes it out. It regroups the lesson (sidebar
 * mark, the course's lesson list, the graph filter); the teacher heard about the course through
 * the study-context marker at the session's birth, and a later change does not rewrite that — the
 * title says so. Renders nothing while there is no course to choose and none is set.
 */

interface CourseOption {
	id: string;
	name: string;
}

export function SessionCourseChip({ chatId, courseId }: { chatId: string; courseId: string | null }) {
	const [courses, setCourses] = useState<CourseOption[]>([]);
	const [value, setValue] = useState<string>(courseId ?? "");
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let live = true;
		void fetch("/api/study/courses")
			.then((r) => r.json() as Promise<{ courses?: CourseOption[] }>)
			.then((j) => {
				if (live) setCourses((j.courses ?? []).map((c) => ({ id: c.id, name: c.name })));
			})
			.catch(() => {
				/* no list: the chip stays out unless a course is set */
			});
		return () => {
			live = false;
		};
	}, []);

	if (courses.length === 0 && !courseId) return null;

	const change = (next: string) => {
		const before = value;
		setValue(next);
		setFailed(false);
		void fetch(`/api/chats/${encodeURIComponent(chatId)}/course`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ courseId: next === "" ? null : next }),
		})
			.then((r) => {
				if (!r.ok) throw new Error(String(r.status));
			})
			.catch(() => {
				setValue(before);
				setFailed(true);
			});
	};

	return (
		<label
			data-testid="course-chip"
			title={failed ? "Could not change the course" : "The course this lesson belongs to (the teacher heard about it when the lesson started)"}
			className={
				"lh-no-drag flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium tracking-wide transition-colors " +
				(failed ? "border-destructive/60 text-destructive" : value !== "" ? "border-border/80 text-foreground" : "border-dashed border-border/80 text-muted-foreground")
			}
		>
			<GraduationCapIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
			<select
				aria-label="Course"
				data-testid="course-chip-select"
				value={value}
				onChange={(e) => change(e.target.value)}
				className="max-w-[12rem] cursor-pointer truncate bg-transparent text-xs outline-none"
			>
				<option value="">No course</option>
				{courses.map((c) => (
					<option key={c.id} value={c.id}>
						{c.name}
					</option>
				))}
				{value !== "" && !courses.some((c) => c.id === value) && <option value={value}>{value}</option>}
			</select>
		</label>
	);
}
