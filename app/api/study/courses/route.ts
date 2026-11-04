import { studyCourses } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/study/courses — every course with today's queue counts. */
export async function GET() {
	return Response.json({ courses: studyCourses() });
}
