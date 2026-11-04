import * as fs from "node:fs";
import { CreateInputError } from "@/src/core";
import { pageImageFile } from "@/src/server";
import { pageParam } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** GET /api/create/jobs/:id/pages/:page/image — the rendered page the focus screen shows. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; page: string }> }) {
	const { id, page } = await params;
	try {
		const file = pageImageFile(id, pageParam(page));
		return new Response(new Uint8Array(fs.readFileSync(file)), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
