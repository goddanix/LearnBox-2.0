import { undoAssign } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** POST /api/create/courses/:id/cards/unassign — give the drafts the labels they had before the assignment. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(() => ({ restored: undoAssign(id) }));
}
