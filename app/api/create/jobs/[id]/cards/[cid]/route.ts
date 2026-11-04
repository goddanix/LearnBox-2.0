import { patchCard } from "@/src/server";
import { bodyOf, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/create/jobs/:id/cards/:cid { front?, back?, text?, extra?, header?, label?, tier?, tags?, include?, deleted? }
 * — change a card draft: its texts, importance, tags, whether it is selected, throw it away or bring it back.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; cid: string }> }) {
	const { id, cid } = await params;
	return respond(async () => ({ card: patchCard(id, cid, await bodyOf(req)) }));
}
