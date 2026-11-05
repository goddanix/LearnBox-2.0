import { listCourseTags } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** GET /api/create/courses/:id/tags — the topic labels on the subject's drafts, with how many are selected. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(() => ({ tags: listCourseTags(id) }));
}
