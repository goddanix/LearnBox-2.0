/**
 * Lessons on the phone (Learnbox 2.0, Slice 10f): which sessions the phone may open and how they are listed. A lesson
 * is a chat with Claude on the Mac; the phone reaches only the ones tied to a study course or to cards, never the
 * Mac's other sessions. No I/O here; server/phone-lessons.ts and the routes are the adapters.
 */

import type { ChatListItem } from "./contracts/chat.ts";
import type { PhoneLesson } from "./contracts/mobile.ts";
import type { StudyLessonStart } from "./contracts/study-link.ts";
import { cleanSubdecks } from "./study-link.ts";

/** A chat id as the Mac makes them (`chat_<time>_<random>`); the gateway lets nothing else into a lesson address. */
export const PHONE_LESSON_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** What a chat record or list row says about its ties. */
interface LessonTies {
	kind?: string;
	courseId?: string;
	cardIds?: readonly string[];
	madeCardIds?: readonly string[];
}

/** A teaching session tied to a study course, to cards it started from or to cards made from it. */
export function isStudyLesson(chat: LessonTies): boolean {
	if ((chat.kind ?? "teach") !== "teach") return false;
	return Boolean(chat.courseId) || (chat.cardIds?.length ?? 0) > 0 || (chat.madeCardIds?.length ?? 0) > 0;
}

/** The lessons of one course, the latest first, as the phone shows them. */
export function phoneLessonsOf(chats: readonly ChatListItem[], courseId: string): PhoneLesson[] {
	return chats
		.filter((c) => isStudyLesson(c) && c.courseId === courseId)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, busy: c.busy, pendingQuestion: c.pendingQuestion }));
}

/**
 * The request that starts a lesson from the phone: the course, optionally the cards, and the learner's first message
 * (it names the lesson, as on the Mac, and is sent as turn 1 once the lesson exists). Anything else is not a start.
 */
export function parsePhoneLessonStart(raw: unknown): { title: string; study: StudyLessonStart } | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const courseId = typeof r.courseId === "string" ? r.courseId : "";
	const title = typeof r.title === "string" ? r.title.trim() : "";
	if (!courseId || !title) return null;
	const cardIds = Array.isArray(r.cardIds) ? r.cardIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
	const topics = cleanSubdecks(r.topics);
	return { title, study: { courseId, ...(cardIds.length > 0 ? { cardIds } : {}), ...(topics.length > 0 ? { topics } : {}) } };
}
