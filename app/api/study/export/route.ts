import { StudyInputError, exportApkg } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/study/export { courseIds, progress, subdecks } — the chosen courses as an Anki package (.apkg), as the
 * response body. The summary travels in `x-learnbox-export` (URI-encoded JSON) so the page can tell what was packed.
 */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as unknown;
	try {
		const result = exportApkg(body);
		const ascii = result.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
		return new Response(new Uint8Array(result.bytes), {
			headers: {
				"content-type": "application/octet-stream",
				"content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
				"x-learnbox-export": encodeURIComponent(JSON.stringify(result.summary)),
				"cache-control": "no-store",
			},
		});
	} catch (err) {
		if (err instanceof StudyInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
