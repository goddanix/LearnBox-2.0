import { GET as readChat } from "@/app/api/chats/[id]/route";
import { phoneLessonGate } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/phone/lesson/<id> — the lesson's record (Slice 10f): the Mac's chat record, for study lessons only. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	return phoneLessonGate(id) ?? readChat(req, ctx);
}
