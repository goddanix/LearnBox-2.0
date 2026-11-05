import { phoneMedia } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/phone/media/<file name> — one media file of a card, for the phone to keep (Slice 10c). */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
	const { name } = await params;
	const found = phoneMedia(name);
	if (!found) return Response.json({ error: "No such media file." }, { status: 404 });
	return new Response(new Uint8Array(found.bytes), { headers: { "Content-Type": found.mime, "Cache-Control": "no-store" } });
}
