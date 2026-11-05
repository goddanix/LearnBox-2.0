import { listCourseViews } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** GET /api/create/courses — every subject with its topics and how many PDFs and drafts were made for it. (A subject is added with POST /api/study/courses.) */
export async function GET() {
	return respond(() => ({ courses: listCourseViews() }));
}
