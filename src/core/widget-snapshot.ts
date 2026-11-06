/**
 * The widget's numbers (Learnbox 2.0, Widget): per course what is due today, what is new, and the days to the exam.
 *
 * PURE. The macOS widget (widget/ — a WidgetKit extension) cannot run anything and may read one small file only, so a
 * helper program (scripts/widget-helper.ts) computes this snapshot from the study ledgers and writes it as JSON; the
 * widget just draws it. The numbers are the review screen's own (core/study-queue.ts `courseOverviews`): the same
 * queue, the same new-cards quota, the same deadline days — not a second implementation.
 */

import type { StudyCard, StudyCourse, StudyReview } from "./contracts/study.ts";
import { clockAt, courseOverviews } from "./study-queue.ts";

export const WIDGET_SNAPSHOT_VERSION = 1;

export interface WidgetCourse {
	id: string;
	name: string;
	/** Cards to answer now: learning + review (what the "due" counter of the review screen adds up). */
	due: number;
	/** New cards the course offers today (the deadline-driven quota, minus what was started already). */
	new: number;
	/** Cards in the course (not suspended). */
	total: number;
	/** Exam day "YYYY-MM-DD", when the course has one. */
	deadline?: string;
	/** Days to the exam while it is active (buffer included), else null. */
	daysLeft: number | null;
}

export interface WidgetSnapshot {
	version: typeof WIDGET_SNAPSHOT_VERSION;
	/** ISO time the snapshot was made. */
	generatedAt: string;
	/** The study day "YYYY-MM-DD" it is for (the day rolls over at 04:00). */
	day: string;
	courses: WidgetCourse[];
	totals: { due: number; new: number };
}

export interface WidgetSource {
	readCourses(): readonly StudyCourse[];
	readCards(): readonly StudyCard[];
	readReviews(): readonly StudyReview[];
}

/** Courses with something to do first (most due), then by name; courses without cards are left out. */
export function widgetSnapshot(source: WidgetSource, now: Date): WidgetSnapshot {
	const clock = clockAt(now);
	const courses = courseOverviews(source.readCourses(), source.readCards(), source.readReviews(), clock)
		.filter((o) => o.total > 0)
		.map(
			(o): WidgetCourse => ({
				id: o.course.id,
				name: o.course.name,
				due: o.counts.learning + o.counts.review,
				new: o.counts.new,
				total: o.total,
				...(o.course.deadline ? { deadline: o.course.deadline } : {}),
				daysLeft: o.daysLeft,
			}),
		)
		.sort((a, b) => b.due + b.new - (a.due + a.new) || a.name.localeCompare(b.name));
	return {
		version: WIDGET_SNAPSHOT_VERSION,
		generatedAt: now.toISOString(),
		day: clock.today,
		courses,
		totals: { due: courses.reduce((n, c) => n + c.due, 0), new: courses.reduce((n, c) => n + c.new, 0) },
	};
}
