import { mobileFailure } from "@/app/api/mobile/failure";
import { mobile } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/mobile/serve { on } — the Settings button: run (or undo) `tailscale serve` for the gateway. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { on?: unknown } | null;
	if (!body || typeof body.on !== "boolean") return Response.json({ error: "on (true or false) is required" }, { status: 400 });
	try {
		return Response.json(await mobile().setServing(body.on));
	} catch (err) {
		return mobileFailure(err);
	}
}
