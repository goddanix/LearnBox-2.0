import { readCourseIds } from "@/src/core";
import { phoneDeck } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/phone/deck[?reviewsFrom=N][&courses=a,b] — the cards, courses and review history a phone studies from
 * offline (Slice 10c); `courses` names the ones the phone chose (all when absent, Slice 10g).
 */
export async function GET(req: Request) {
	const params = new URL(req.url).searchParams;
	const from = Number(params.get("reviewsFrom") ?? "0");
	const ids = readCourseIds(params.get("courses"));
	if (ids === null) return Response.json({ error: "The course list is not valid." }, { status: 400 });
	return Response.json(phoneDeck(Number.isFinite(from) ? from : 0, new Date(), undefined, ids), { headers: { "Cache-Control": "no-store" } });
}
