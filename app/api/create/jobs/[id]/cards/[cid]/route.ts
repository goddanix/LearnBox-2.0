import { CreateInputError } from "@/src/core";
import { setCardDeleted } from "@/src/server";

export const dynamic = "force-dynamic";

/** PATCH /api/create/jobs/:id/cards/:cid { deleted: boolean } — throw a card draft away or bring it back. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; cid: string }> }) {
	const { id, cid } = await params;
	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body.deleted !== "boolean") {
		return Response.json({ error: "deleted (boolean) is required" }, { status: 400 });
	}
	try {
		return Response.json({ card: setCardDeleted(id, cid, body.deleted) });
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
