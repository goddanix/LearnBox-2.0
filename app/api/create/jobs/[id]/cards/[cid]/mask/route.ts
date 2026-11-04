import { editMask } from "@/src/server";
import { bodyOf, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/**
 * POST /api/create/jobs/:id/cards/:cid/mask { bbox?, figure? } — move or scale the mask of an occlusion card
 * and/or change the part of the page its picture shows (boxes are page-normalised [x0,y0,x1,y1]).
 * The page's pictures are drawn again; the answer holds the page's cards.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; cid: string }> }) {
	const { id, cid } = await params;
	return respond(async () => {
		const body = await bodyOf(req);
		return { cards: await editMask(id, cid, { bbox: body.bbox, figure: body.figure }) };
	});
}
