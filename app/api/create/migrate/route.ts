import { CreateInputError, type MigrateJobChoice } from "@/src/core";
import { importMedAnki, scanMedAnki } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/create/migrate { path?, apply?, jobs? } — everything MedAnki made: its subjects, PDF jobs with their cards, the topic
 * notes and audio summary, the Obsidian vault and the multiple-choice tests. Without `apply` it is the dry run: { scan } lists what
 * is there and what would be linked, writing nothing. With `apply: true` it brings over what is not in Learnbox yet and returns
 * { result }; `jobs` is the learner's choice of PDF jobs and the course of each (every job, in its own course, without it).
 * MedAnki's folder is only read.
 */
export async function POST(req: Request) {
	const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
	const dir = typeof body.path === "string" ? body.path : undefined;
	try {
		if (body.apply === true) {
			const jobs = Array.isArray(body.jobs) ? (body.jobs as MigrateJobChoice[]) : undefined;
			return Response.json({ result: await importMedAnki({ path: dir, jobs }) });
		}
		return Response.json({ scan: scanMedAnki(dir) });
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
