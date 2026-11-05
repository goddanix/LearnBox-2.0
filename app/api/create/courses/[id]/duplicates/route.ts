import { CreateInputError } from "@/src/core";
import { removeCourseDuplicates, reviewCourseDuplicates } from "@/src/server";
import { bodyOf, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** GET /api/create/courses/:id/duplicates?threshold=0.8 — groups of duplicate cards across all PDFs of the subject, plus the ones Claude found so far. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(() => {
		const raw = new URL(req.url).searchParams.get("threshold");
		const threshold = raw === null ? undefined : Number(raw);
		return reviewCourseDuplicates(id, Number.isFinite(threshold) ? threshold : undefined);
	});
}

/** POST /api/create/courses/:id/duplicates { groups: [{ keep, remove: [ref] }] } — refs are "jobId|cardId"; the other cards are thrown away (restorable). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(async () => {
		const body = await bodyOf(req);
		if (!Array.isArray(body.groups)) throw new CreateInputError("groups (list) is required", 400);
		const groups = body.groups.flatMap((g: unknown) => {
			const r = g as { keep?: unknown; remove?: unknown };
			return typeof r?.keep === "string" && Array.isArray(r.remove) ? [{ keep: r.keep, remove: r.remove.filter((x): x is string => typeof x === "string") }] : [];
		});
		return { removed: removeCourseDuplicates(id, groups) };
	});
}
