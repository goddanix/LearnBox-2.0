import { StudyInputError, studyNext } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/study/next?course=<id>&step=<n>[&card=<id>] — the next card (card: null = done for
 * today); `card` opens that card first, falling back to the queue when it cannot be shown.
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const course = url.searchParams.get("course") ?? "";
	const step = Number(url.searchParams.get("step") ?? "0");
	const card = url.searchParams.get("card") ?? undefined;
	try {
		return Response.json(studyNext(course, step, undefined, undefined, card));
	} catch (err) {
		if (err instanceof StudyInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
