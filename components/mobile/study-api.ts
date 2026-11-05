/**
 * What the phone's review screens ask of the study engine (Learnbox 2.0, Slice 10): the phone's own copy of the
 * cards and the scheduler (phone-engine.ts) answers. The screens know only this interface — tests give them a fake.
 */

import type { StudyCourseSummary, StudyGrade, StudyNextResult } from "@/src/core";

export interface PhoneStudyApi {
	courses(): Promise<StudyCourseSummary[]>;
	/** The next card of a course (`step` 0 starts a session); `openCardId` shows that card first. */
	next(courseId: string, step: number, openCardId?: string): Promise<StudyNextResult>;
	answer(input: { courseId: string; cardId: string; grade: StudyGrade; ms: number; step: number }): Promise<StudyNextResult>;
	undo(input: { courseId: string; cardId: string; step: number }): Promise<StudyNextResult>;
}

export { PhoneApiError } from "./phone-http";
export type { PhoneApiErrorKind } from "./phone-http";
