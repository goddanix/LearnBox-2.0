import { CreateInputError } from "@/src/core";
import { setQuestionDeleted } from "@/src/server";

export const dynamic = "force-dynamic";

/** PATCH /api/create/jobs/:id/questions/:qid { deleted: boolean } — throw a draft away or bring it back. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; qid: string }> }) {
	const { id, qid } = await params;
	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body.deleted !== "boolean") {
		return Response.json({ error: "deleted (boolean) is required" }, { status: 400 });
	}
	try {
		return Response.json({ question: setQuestionDeleted(id, qid, body.deleted) });
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
