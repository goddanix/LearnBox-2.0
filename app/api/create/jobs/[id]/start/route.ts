import { CreateInputError } from "@/src/core";
import { startCreateJob } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/create/jobs/:id/start { pages?, more? } — resume the unfinished pages, retry just
 * `pages`, or with `more` ask for further, different questions on every page; returns { started }
 * (false when a run is already going or there is nothing left to do). A cards job takes `pages`
 * only: naming a page runs it again (cards you made or adopted there stay).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
	const pages = Array.isArray(body.pages) ? body.pages.filter((p): p is number => Number.isInteger(p)) : undefined;
	try {
		return Response.json({ started: startCreateJob(id, { pages, more: body.more === true }).started });
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
