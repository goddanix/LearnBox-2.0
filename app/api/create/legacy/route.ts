import { CreateInputError } from "@/src/core";
import { importMedAnkiMcq, scanMedAnkiMcq } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/create/legacy { path?, apply? } — MedAnki's multiple-choice jobs. Without `apply`
 * it is the dry run: { scan } lists what is there and what would be linked, writing nothing.
 * With `apply: true` it imports the jobs not yet in Learnbox and returns { result }.
 * MedAnki's folder is only read.
 */
export async function POST(req: Request) {
	const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
	const dir = typeof body.path === "string" ? body.path : undefined;
	try {
		if (body.apply === true) return Response.json({ result: await importMedAnkiMcq(dir) });
		return Response.json({ scan: scanMedAnkiMcq(dir) });
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
