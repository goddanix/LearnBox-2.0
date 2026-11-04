import { semanticDedupeStep } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/create/jobs/:id/duplicates/check { threshold? } — ONE step of Claude's content check (about 30 cards per call).
 * Call it again until `done`; a failed call reports `error` and keeps the progress.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(async () => {
		const body: unknown = await req.json().catch(() => null);
		const t = typeof body === "object" && body !== null ? Number((body as { threshold?: unknown }).threshold) : NaN;
		return semanticDedupeStep(id, { threshold: Number.isFinite(t) ? t : undefined, signal: req.signal });
	});
}
