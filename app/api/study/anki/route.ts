import { listAnkiCollections } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/study/anki — Anki collections found under Anki's data folder (listing only, nothing is opened). */
export async function GET() {
	return Response.json({ collections: listAnkiCollections() });
}
