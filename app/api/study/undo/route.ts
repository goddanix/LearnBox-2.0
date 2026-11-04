import { StudyInputError, studyUndo } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/study/undo { courseId, cardId, step? } — takes back the card's latest review, returns that card again. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body.courseId !== "string" || typeof body.cardId !== "string") {
		return Response.json({ error: "courseId and cardId are required" }, { status: 400 });
	}
	try {
		return Response.json(
			studyUndo({
				courseId: body.courseId,
				cardId: body.cardId,
				step: typeof body.step === "number" ? body.step : undefined,
			}),
		);
	} catch (err) {
		if (err instanceof StudyInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
