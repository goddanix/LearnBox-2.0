import { addManualCard } from "@/src/server";
import { bodyOf, pageParam, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/**
 * POST /api/create/jobs/:id/pages/:page/cards { type: "basic" | "basic_reversed" | "image_occlusion", front?, back?,
 * label?, header?, bbox?, figure?, extra?, tier?, tags? } — make a card by hand on a page. The answer holds the page's cards.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; page: string }> }) {
	const { id, page } = await params;
	return respond(async () => ({ cards: await addManualCard(id, pageParam(page), await bodyOf(req)) }));
}
