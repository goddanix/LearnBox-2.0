import { importPhoneBackup, PhoneSyncInputError } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/mobile/backup — a backup file saved on a phone, read in on the Mac (Settings → Phone). Safe to repeat. */
export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "This is not a Learnbox phone backup file." }, { status: 400 });
	}
	try {
		return Response.json(importPhoneBackup(body));
	} catch (err) {
		if (err instanceof PhoneSyncInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
}
