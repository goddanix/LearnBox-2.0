import { StudyInputError, studyCardAction, type StudyCardAction } from "@/src/server";

export const dynamic = "force-dynamic";

const ACTIONS: readonly string[] = ["suspend", "unsuspend", "bury", "unbury", "edit"] satisfies StudyCardAction[];

/** POST /api/study/card { courseId, cardId, action, fields?, step? } — suspend / bury / edit one card; returns the course state. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (
		!body ||
		typeof body.courseId !== "string" ||
		typeof body.cardId !== "string" ||
		typeof body.action !== "string" ||
		!ACTIONS.includes(body.action)
	) {
		return Response.json({ error: "courseId, cardId and a valid action are required" }, { status: 400 });
	}
	try {
		return Response.json(
			studyCardAction({
				courseId: body.courseId,
				cardId: body.cardId,
				action: body.action as StudyCardAction,
				fields: body.fields as Record<string, string> | undefined,
				step: typeof body.step === "number" ? body.step : undefined,
			}),
		);
	} catch (err) {
		if (err instanceof StudyInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
