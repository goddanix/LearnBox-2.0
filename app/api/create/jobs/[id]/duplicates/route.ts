import { CreateInputError } from "@/src/core";
import { removeDuplicates, reviewDuplicates, semanticGroups } from "@/src/server";
import { bodyOf, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** GET /api/create/jobs/:id/duplicates?threshold=0.8 — groups of duplicate cards (the quick comparison) plus the ones Claude found so far. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(() => {
		const raw = new URL(req.url).searchParams.get("threshold");
		const threshold = raw === null ? undefined : Number(raw);
		const review = reviewDuplicates(id, Number.isFinite(threshold) ? threshold : undefined);
		return { ...review, semantic: semanticGroups(id) };
	});
}

/** POST /api/create/jobs/:id/duplicates { groups: [{ keep, remove: [cardId] }] } — throw the other cards of the groups away (restorable). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(async () => {
		const body = await bodyOf(req);
		if (!Array.isArray(body.groups)) throw new CreateInputError("groups (list) is required", 400);
		const groups = body.groups.flatMap((g: unknown) => {
			const r = g as { keep?: unknown; remove?: unknown };
			return typeof r?.keep === "string" && Array.isArray(r.remove) ? [{ keep: r.keep, remove: r.remove.filter((x): x is string => typeof x === "string") }] : [];
		});
		return { removed: removeDuplicates(id, groups) };
	});
}
