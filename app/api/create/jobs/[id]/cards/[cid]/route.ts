import { createJobKind, patchCard, patchLessonCard } from "@/src/server";
import { bodyOf, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/create/jobs/:id/cards/:cid { front?, back?, text?, extra?, header?, label?, tier?, tags?, include?, deleted? }
 * — change a card draft: its texts, importance, tags, whether it is selected, throw it away or bring it back.
 * A lesson job's draft takes front, back, text, extra, include and deleted.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; cid: string }> }) {
	const { id, cid } = await params;
	return respond(async () => {
		const body = await bodyOf(req);
		return { card: createJobKind(id) === "lesson" ? patchLessonCard(id, cid, body) : patchCard(id, cid, body) };
	});
}
