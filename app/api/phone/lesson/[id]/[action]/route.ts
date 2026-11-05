import { POST as dismissQuestion } from "@/app/api/chats/[id]/dismiss/route";
import { POST as steerTurn } from "@/app/api/chats/[id]/steer/route";
import { GET as attachStream } from "@/app/api/chats/[id]/stream/route";
import { handleChatRequest, isTurnRunning, phoneLessonGate } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; action: string }> };

/**
 * The turn's wire for a phone lesson (Slice 10f) — the Mac's own chat routes, behind the study-lesson gate:
 * GET stream (the live turn, replayed from its start) and turn (is one running); POST send (one input: a message or
 * an answer; the chat id comes from the address), steer and dismiss. Nothing else of the chat surface is reachable.
 */
export async function GET(req: Request, ctx: Ctx) {
	const { id, action } = await ctx.params;
	const refused = phoneLessonGate(id);
	if (refused) return refused;
	if (action === "stream") return attachStream(req, { params: Promise.resolve({ id }) });
	if (action === "turn") return Response.json({ turnInFlight: isTurnRunning(id) });
	return Response.json({ error: "Not found" }, { status: 404 });
}

export async function POST(req: Request, ctx: Ctx) {
	const { id, action } = await ctx.params;
	const refused = phoneLessonGate(id);
	if (refused) return refused;
	const params = { params: Promise.resolve({ id }) };
	if (action === "steer") return steerTurn(req, params);
	if (action === "dismiss") return dismissQuestion(req, params);
	if (action === "send") {
		const body = (await req.json().catch(() => null)) as { input?: unknown } | null;
		return handleChatRequest(new Request(req.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: id, input: body?.input }) }));
	}
	return Response.json({ error: "Not found" }, { status: 404 });
}
