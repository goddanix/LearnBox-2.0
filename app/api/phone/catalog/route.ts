import { phoneCatalog } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/phone/catalog — every course on the Mac with its card count and media size, for the phone's choice (Slice 10g). */
export async function GET() {
	return Response.json(phoneCatalog(), { headers: { "Cache-Control": "no-store" } });
}
