import { GET as listChats } from "@/app/api/chats/route";
import { phoneLessonsOf } from "@/src/core";
import type { ChatListItem } from "@/src/core";

export const dynamic = "force-dynamic";

/** GET /api/phone/lessons?course=<id> — the course's lessons, latest first (Slice 10f): study lessons only, a few fields each. */
export async function GET(req: Request) {
	const course = new URL(req.url).searchParams.get("course");
	if (!course) return Response.json({ error: "course is required" }, { status: 400 });
	const { chats } = (await (await listChats()).json()) as { chats: ChatListItem[] };
	return Response.json({ lessons: phoneLessonsOf(chats, course) });
}
