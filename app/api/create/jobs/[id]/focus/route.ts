import { setFocus } from "@/src/server";
import { bodyOf, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** PATCH /api/create/jobs/:id/focus { focusTopics?, focusStrict? } — the topics the cards favour; counts for pages processed from now on. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(async () => setFocus(id, await bodyOf(req)));
}
