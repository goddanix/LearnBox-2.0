import { StudyInputError, createStudyCourse, studyCourses } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/study/courses — every course with today's queue counts. */
export async function GET() {
	return Response.json({ courses: studyCourses() });
}

/** POST /api/study/courses { name, deadline?, bufferDays? } — add a course (Fach); returns it. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) return Response.json({ error: "A JSON body is required" }, { status: 400 });
	try {
		return Response.json({ course: createStudyCourse(body) });
	} catch (err) {
		if (err instanceof StudyInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
