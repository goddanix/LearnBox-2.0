import { assignStatus, startAssign } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** POST /api/create/courses/:id/cards/assign — start giving every draft of the subject the topic it belongs to (in the background; poll GET). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(() => ({ started: startAssign(id) }));
}

/** GET /api/create/courses/:id/cards/assign — how far the assignment is. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(() => assignStatus(id));
}
