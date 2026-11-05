import { CreateInputError } from "@/src/core";
import { createJobKind, deleteCreateJob, getCardsJob, getCreateJob, getLessonJob } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/create/jobs/:id — the job with its pages and drafts (questions, PDF cards or lesson cards, by the job's kind). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const kind = createJobKind(id);
		return Response.json(kind === "cards" ? getCardsJob(id) : kind === "lesson" ? getLessonJob(id) : getCreateJob(id));
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

/** DELETE /api/create/jobs/:id — remove a finished job with its drafts (409 while it runs). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		deleteCreateJob(id);
		return new Response(null, { status: 204 });
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
