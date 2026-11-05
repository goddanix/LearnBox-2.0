import { getCourseView, updateCourse } from "@/src/server";
import { bodyOf, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** GET /api/create/courses/:id — one subject. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(() => ({ course: getCourseView(id) }));
}

/** PUT /api/create/courses/:id { name?, topics?, strict? } — rename the subject, set its topics, switch "only these topics". */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(async () => ({ course: updateCourse(id, await bodyOf(req)) }));
}
