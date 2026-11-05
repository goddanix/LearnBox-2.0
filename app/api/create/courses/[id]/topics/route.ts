import { CreateInputError } from "@/src/core";
import { topicsFromFile } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Largest topic file taken (a PDF of goals is a few hundred KB at most). */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * POST /api/create/courses/:id/topics (multipart, field "file") — take the topic list from a .txt / .md file (every line a
 * topic) or a PDF (Claude sums up its text). With topics set already the entries are matched to them; returns what changed.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(async () => {
		const form = await req.formData().catch(() => null);
		const file = form?.get("file");
		if (!(file instanceof File)) throw new CreateInputError("A file is required", 400);
		if (file.size > MAX_BYTES) throw new CreateInputError("The file is too large (over 25 MB)", 400);
		return topicsFromFile(id, { name: file.name, data: new Uint8Array(await file.arrayBuffer()) }, { signal: req.signal });
	});
}
