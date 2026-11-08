import { readCourseIds, readTopicChoice } from "@/src/core";
import { phoneDeck } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/phone/deck[?reviewsFrom=N][&courses=a,b][&topics={"a":["W1"]}] — the cards, courses and review history a
 * phone studies from offline (Slice 10c); `courses` names the ones the phone chose (all when absent, Slice 10g) and
 * `topics` the subdecks of the courses it holds only in part (a course it does not name comes whole, Slice 10h).
 */
export async function GET(req: Request) {
	const params = new URL(req.url).searchParams;
	const from = Number(params.get("reviewsFrom") ?? "0");
	const ids = readCourseIds(params.get("courses"));
	if (ids === null) return Response.json({ error: "The course list is not valid." }, { status: 400 });
	const topics = readTopicChoice(params.get("topics"));
	if (topics === null) return Response.json({ error: "The subdeck list is not valid." }, { status: 400 });
	return Response.json(phoneDeck(Number.isFinite(from) ? from : 0, new Date(), undefined, ids, topics), { headers: { "Cache-Control": "no-store" } });
}
