import { editImage } from "@/src/server";
import { bodyOf, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** POST /api/create/jobs/:id/cards/:cid/image { bbox } — change the part of the page a card's context picture shows. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; cid: string }> }) {
	const { id, cid } = await params;
	return respond(async () => ({ card: await editImage(id, cid, (await bodyOf(req)).bbox) }));
}
