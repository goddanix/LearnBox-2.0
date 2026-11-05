import { NewSession } from "@/components/new-session";
import { readSettingsRecord, studyCourses, studyLinkCards } from "@/src/server";
import { slotsConfigured, suggestedFirstMessage, type StudyLinkCard } from "@/src/core";

export const dynamic = "force-dynamic";

/**
 * The draft view behind "+ New session" (owner, 2026-09-13): NO session is
 * created until the first message is sent — the view is a sessionless empty
 * chat; on send it creates the chat (title = that message) and redirects to
 * the real page, whose initialPrompt path delivers the message as turn 1.
 * Static segment beats the dynamic [id] route — "new" is never a chat id.
 *
 * The draft's model control binds the STRONG SLOT (the new-session
 * default); the session the first send creates is stamped from it
 * server-side (per-session models, owner 2026-09-28).
 */
export default async function NewSessionPage({
	searchParams,
}: {
	searchParams: Promise<{ mode?: string; course?: string; cards?: string }>;
}) {
	const { mode, course, cards } = await searchParams;
	const teach = mode !== "practice";
	// A lesson for a course, optionally from flashcards (Learnbox 2.0, Slice 9): the link names
	// ids only; the course list and the cards' text are read here, from the ledgers. A stale or
	// foreign link (unknown course or card) simply opens the plain draft.
	const courses = teach ? studyCourses().map((c) => ({ id: c.id, name: c.name })) : [];
	let initialCourseId = "";
	let initialCards: StudyLinkCard[] = [];
	if (teach && course && courses.some((c) => c.id === course)) {
		initialCourseId = course;
		try {
			initialCards = cards ? studyLinkCards(course, cards.split(",")) : [];
		} catch {
			initialCards = [];
		}
	}
	return (
		<NewSession
			initialConfigured={slotsConfigured(readSettingsRecord()?.models)}
			mode={teach ? "teach" : "practice"}
			courses={courses}
			initialCourseId={initialCourseId}
			initialCards={initialCards}
			initialText={initialCards.length > 0 ? suggestedFirstMessage(initialCards.length) : ""}
		/>
	);
}
