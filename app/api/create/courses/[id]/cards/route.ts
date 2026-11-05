import { listCourseCards } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** GET /api/create/courses/:id/cards?tag=… — the drafts of the subject (all its PDFs) that are not thrown away, optionally those with one label. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(() => ({ cards: listCourseCards(id, new URL(req.url).searchParams.get("tag") ?? undefined) }));
}
