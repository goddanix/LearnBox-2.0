import { acceptPhoneSync, PhoneSyncInputError } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/phone/sync — the answers a phone gave while it was away (Slice 10d). Safe to repeat. */
export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Send the answers as JSON: { reviews: [...] }." }, { status: 400 });
	}
	try {
		return Response.json(acceptPhoneSync(body), { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		if (err instanceof PhoneSyncInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
}
