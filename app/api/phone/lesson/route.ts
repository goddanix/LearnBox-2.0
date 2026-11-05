import { POST as startChat } from "@/app/api/chats/route";
import { parsePhoneLessonStart } from "@/src/core";

export const dynamic = "force-dynamic";

/**
 * POST /api/phone/lesson { courseId, cardIds?, title } — start a lesson for a course (from cards) on the Mac (Slice 10f).
 * The title is the learner's first message; the phone sends it as turn 1 once the lesson exists. Everything else is
 * the Mac's own create route (the study context is read from the ledgers, a stale card is a 4xx), reached with a
 * study lesson's fields only: the phone cannot create any other kind of session.
 */
export async function POST(req: Request) {
	const start = parsePhoneLessonStart(await req.json().catch(() => null));
	if (!start) return Response.json({ error: "courseId and a first message are required" }, { status: 400 });
	return startChat(new Request(req.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(start) }));
}
