import * as fs from "node:fs";
import { CreateInputError } from "@/src/core";
import { cardMediaFile } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/create/jobs/:id/media/:name — a rendered picture of a cards job (the names carry a content hash, so they never change). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await params;
	try {
		const { file, type } = cardMediaFile(id, name);
		return new Response(new Uint8Array(fs.readFileSync(file)), {
			headers: { "content-type": type, "cache-control": "private, max-age=31536000, immutable" },
		});
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
