import * as fs from "node:fs";
import { CreateInputError } from "@/src/core";
import { defaultNotesDeps, noteFigureFile } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/create/courses/:id/notes/media/:name — a figure of the note set (for the preview); found by its file name in the vault. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await params;
	try {
		const { file, type } = noteFigureFile(id, name, defaultNotesDeps());
		return new Response(new Uint8Array(fs.readFileSync(file)), { headers: { "content-type": type, "cache-control": "private, max-age=60" } });
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
