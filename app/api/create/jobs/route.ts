import { CreateInputError } from "@/src/core";
import { createMcqJob, listCreateJobs } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/create/jobs — every Create job, newest first (the page polls this for progress). */
export async function GET() {
	return Response.json({ jobs: listCreateJobs() });
}

/**
 * POST /api/create/jobs { lectureId, sourceLectureId?, settings?, autostart? } — make an MC-test
 * job for a library PDF and (unless autostart is false) start it; returns { job }.
 */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body.lectureId !== "string") {
		return Response.json({ error: "lectureId is required" }, { status: 400 });
	}
	try {
		const job = await createMcqJob({
			lectureId: body.lectureId,
			sourceLectureId: typeof body.sourceLectureId === "string" && body.sourceLectureId ? body.sourceLectureId : undefined,
			settings: body.settings,
			autostart: body.autostart !== false,
		});
		return Response.json({ job });
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
