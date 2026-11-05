import { getChat, stores } from "@/src/server";

/**
 * PUT /api/chats/[id]/course { courseId: string | null } — assign a lesson to a study course, or
 * take it out (null). Only the grouping changes (sidebar mark, the course's lesson list, the
 * graph filter): the teacher heard about the course through the marker at the session's birth, a
 * later change does not rewrite that. Like a rename, updatedAt stays put.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { courseId?: unknown } | null;
	const courseId = body?.courseId;
	if (courseId !== null && typeof courseId !== "string") {
		return Response.json({ error: "courseId must be a course id or null" }, { status: 400 });
	}
	if (courseId !== null && !stores.studyStore.readCourses().some((c) => c.id === courseId)) {
		return Response.json({ error: "Unknown course" }, { status: 404 });
	}
	const record = stores.chatStore.setChatCourse(id, courseId);
	return Response.json({ courseId: record.courseId ?? null });
}
