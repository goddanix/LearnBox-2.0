import { CreateInputError } from "@/src/core";
import { adoptQuestions } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/create/jobs/:id/adopt { courseId, questionIds? } — turn the job's drafts (all that
 * are neither deleted nor adopted, or just `questionIds`) into study cards of the course.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body.courseId !== "string") {
		return Response.json({ error: "courseId is required" }, { status: 400 });
	}
	const questionIds = Array.isArray(body.questionIds) ? body.questionIds.filter((q): q is string => typeof q === "string") : undefined;
	try {
		return Response.json(adoptQuestions(id, { courseId: body.courseId, questionIds }));
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
