import { StudyInputError, studyAnswer } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/study/answer { courseId, cardId, grade, ms?, step? } — records the review, returns the next card. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body.courseId !== "string" || typeof body.cardId !== "string" || typeof body.grade !== "number") {
		return Response.json({ error: "courseId, cardId and grade are required" }, { status: 400 });
	}
	try {
		return Response.json(
			studyAnswer({
				courseId: body.courseId,
				cardId: body.cardId,
				grade: body.grade,
				ms: typeof body.ms === "number" ? body.ms : undefined,
				step: typeof body.step === "number" ? body.step : undefined,
			}),
		);
	} catch (err) {
		if (err instanceof StudyInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
