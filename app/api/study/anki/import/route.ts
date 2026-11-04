import { StudyInputError, runAnkiImport } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/study/anki/import { path, plan } — import under the owner's deck → course plan (idempotent). */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { path?: unknown; plan?: unknown } | null;
	try {
		return Response.json(runAnkiImport(body?.path, body?.plan));
	} catch (err) {
		if (err instanceof StudyInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
