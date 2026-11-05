import { proposeTopics } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** POST /api/create/courses/:id/topics/consolidate — a tidier topic list as a PROPOSAL (nothing is saved; take it with PUT /api/create/courses/:id). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(() => proposeTopics(id, { signal: req.signal }));
}
