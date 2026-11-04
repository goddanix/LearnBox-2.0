import { StudyInputError, studyNext } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/study/next?course=<id>&step=<n> — the next card (card: null = done for today). */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const course = url.searchParams.get("course") ?? "";
	const step = Number(url.searchParams.get("step") ?? "0");
	try {
		return Response.json(studyNext(course, step));
	} catch (err) {
		if (err instanceof StudyInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
