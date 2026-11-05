import { mobileFailure } from "@/app/api/mobile/failure";
import { mobile } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/mobile — phone access at a glance: switch, gateway, Tailscale, paired phones. */
export async function GET() {
	return Response.json(await mobile().status());
}

/** POST /api/mobile { enabled } — switch the gateway on or off (off also takes our Tailscale Serve down). */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
	if (!body || typeof body.enabled !== "boolean") return Response.json({ error: "enabled (true or false) is required" }, { status: 400 });
	try {
		return Response.json(await mobile().setEnabled(body.enabled));
	} catch (err) {
		return mobileFailure(err);
	}
}
