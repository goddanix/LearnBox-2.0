/**
 * Lessons for the phone (Learnbox 2.0, Slice 10f), the server side: the one gate every phone lesson route passes. A
 * lesson is a chat with Claude on the Mac; the phone may open the ones tied to a study course or to cards and nothing
 * else of the Mac's sessions, whatever id it names.
 */

import { isStudyLesson, PHONE_LESSON_ID } from "../core/phone-lessons.ts";
import { getChat } from "./chats.ts";

/**
 * Null when `id` is a lesson the phone may open, else the answer to send. A session that exists but is no study lesson
 * answers exactly like one that does not exist, so the phone learns nothing about the Mac's other sessions.
 */
export function phoneLessonGate(id: string): Response | null {
	const chat = PHONE_LESSON_ID.test(id) ? getChat(id) : null;
	return chat && isStudyLesson(chat) ? null : Response.json({ error: "Unknown lesson" }, { status: 404 });
}
