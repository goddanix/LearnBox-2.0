import { CreateInputError } from "@/src/core";
import { adoptCards, adoptLessonCards, adoptQuestions, createJobKind } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/create/jobs/:id/adopt { courseId, questionIds? | cardIds? } — turn the job's drafts (all
 * that are neither deleted nor adopted, or just `questionIds` of an MC test / `cardIds` of a cards
 * or lesson job) into study cards of the course (a lesson job's always as core knowledge).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body.courseId !== "string") {
		return Response.json({ error: "courseId is required" }, { status: 400 });
	}
	const questionIds = Array.isArray(body.questionIds) ? body.questionIds.filter((q): q is string => typeof q === "string") : undefined;
	try {
		const kind = createJobKind(id);
		if (kind === "cards" || kind === "lesson") {
			const cardIds = Array.isArray(body.cardIds) ? body.cardIds.filter((c): c is string => typeof c === "string") : undefined;
			return Response.json(kind === "lesson" ? adoptLessonCards(id, { courseId: body.courseId, cardIds }) : adoptCards(id, { courseId: body.courseId, cardIds }));
		}
		return Response.json(adoptQuestions(id, { courseId: body.courseId, questionIds }));
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
