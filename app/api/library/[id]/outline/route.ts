/**
 * POST /api/library/:id/outline — start the topic outline for one lecture.
 * Returns 202 with the record (status "outlining") at once; the run goes on
 * in the background and the client polls GET /api/library for status,
 * progress and the finished outline. A run already in flight returns the
 * same 202. With no model (or no key for it) set up the route refuses with
 * the shared 503 envelope and leaves the lecture untouched.
 */
import { startOutline } from "@/src/server";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "@/src/core";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^[A-Za-z0-9_-]+$/.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
	try {
		const source = startOutline(id);
		if (!source) return Response.json({ error: "Not found" }, { status: 404 });
		return Response.json({ source }, { status: 202 });
	} catch (err) {
		if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
			return Response.json(err.envelope, { status: 503 });
		}
		throw err;
	}
}
