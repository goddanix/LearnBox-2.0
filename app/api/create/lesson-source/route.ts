import { lessonSource } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/**
 * GET /api/create/lesson-source?chat=<id> | ?nodes=<id>,<id> — the statements a lesson-cards job can be made from:
 * the propositions the lesson touched, or the ones picked on the graph, each with the number of study cards that
 * already come from it; plus the lesson's title and course for the form.
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const chat = url.searchParams.get("chat");
	const nodes = (url.searchParams.get("nodes") ?? "").split(",").filter(Boolean);
	return respond(() => lessonSource({ chatId: chat || undefined, nodeIds: nodes }));
}
