import { phoneDeck } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/phone/deck[?reviewsFrom=N] — the cards, courses and review history a phone studies from offline (Slice 10c). */
export async function GET(req: Request) {
	const from = Number(new URL(req.url).searchParams.get("reviewsFrom") ?? "0");
	return Response.json(phoneDeck(Number.isFinite(from) ? from : 0), { headers: { "Cache-Control": "no-store" } });
}
