import { getLecture, removeLecture } from "@/src/server";

export const dynamic = "force-dynamic";

/** Ids are minted by the store; anything else cannot exist (and must never reach the fs). */
const validId = (id: string) => /^[A-Za-z0-9_-]+$/.test(id);

/** GET /api/library/:id — one lecture's record (status, progress, outline). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const source = validId(id) ? getLecture(id) : null;
	if (!source) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ source });
}

/** DELETE /api/library/:id — remove a lecture's PDF and record (aborts a running outline). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!validId(id) || !removeLecture(id)) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	return new Response(null, { status: 204 });
}
