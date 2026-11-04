import { StudyInputError, inspectAnki } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/study/anki/inspect { path } — read a COPY of the collection: decks, note types, suggested plan. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { path?: unknown } | null;
	try {
		return Response.json(inspectAnki(body?.path));
	} catch (err) {
		if (err instanceof StudyInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
