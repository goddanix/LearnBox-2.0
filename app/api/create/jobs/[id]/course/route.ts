import { setJobCourse } from "@/src/server";
import { bodyOf, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** PUT /api/create/jobs/:id/course { courseId: string | null } — put the PDF's cards job into a subject (null: out of any). Its topics become the focus unless the job has a focus of its own. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(async () => {
		const body = await bodyOf(req);
		return { job: setJobCourse(id, typeof body.courseId === "string" && body.courseId ? body.courseId : null) };
	});
}
