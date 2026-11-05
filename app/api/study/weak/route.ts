import { StudyInputError, studyWeakSpots } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/study/weak?course=<id> — the course's weak spots (most lapses first, plain-text faces). */
export async function GET(req: Request) {
	const course = new URL(req.url).searchParams.get("course");
	if (!course) return Response.json({ error: "course is required" }, { status: 400 });
	try {
		return Response.json(studyWeakSpots(course));
	} catch (err) {
		if (err instanceof StudyInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
