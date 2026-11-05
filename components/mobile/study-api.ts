/**
 * What the phone's review screens ask of the study engine (Learnbox 2.0, Slice 10): the phone's own copy of the
 * cards and the scheduler (phone-engine.ts) answers. The screens know only this interface — tests give them a fake.
 */

import type { PhoneCardAction, StudyCourseSummary, StudyGrade, StudyLinkCard, StudyNextResult } from "@/src/core";

export interface PhoneStudyApi {
	courses(): Promise<StudyCourseSummary[]>;
	/** The next card of a course (`step` 0 starts a session); `openCardId` shows that card first. */
	next(courseId: string, step: number, openCardId?: string): Promise<StudyNextResult>;
	answer(input: { courseId: string; cardId: string; grade: StudyGrade; ms: number; step: number }): Promise<StudyNextResult>;
	undo(input: { courseId: string; cardId: string; step: number }): Promise<StudyNextResult>;
	/** The course's weak spots, from the phone's own cards and answers (so they show without a connection): most lapses first. */
	weakSpots(courseId: string): Promise<StudyLinkCard[]>;
	/** The given cards of a course as a lesson sees them (plain-text faces, lapses): what the start of a lesson shows. Unknown ids are left out. */
	linkCards(courseId: string, cardIds: readonly string[]): Promise<StudyLinkCard[]>;
	/** Pause, bury or edit a card (kept on the phone until the Mac has it); the next card comes back as after an answer. */
	cardAction(input: { courseId: string; cardId: string; action: PhoneCardAction; fields?: Record<string, string>; step: number }): Promise<StudyNextResult>;
}

export { PhoneApiError } from "./phone-http";
export type { PhoneApiErrorKind } from "./phone-http";
