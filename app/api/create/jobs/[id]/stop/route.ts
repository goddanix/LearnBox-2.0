import { stopCreateJob } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/create/jobs/:id/stop — stop a running job; its unfinished pages stay resumable. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return Response.json({ stopped: stopCreateJob(id) });
}
