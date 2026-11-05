import { mobile } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/mobile/devices/<id> — lock this phone: its key opens nothing from now on. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const device = mobile().revoke(id);
	return device ? Response.json({ device }) : Response.json({ error: "No such phone." }, { status: 404 });
}

/** DELETE /api/mobile/devices/<id> — take the phone off the list (it has to be paired again). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return mobile().forget(id) ? new Response(null, { status: 204 }) : Response.json({ error: "No such phone." }, { status: 404 });
}
