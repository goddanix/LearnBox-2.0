import { CreateInputError } from "@/src/core";
import { createCardsJob, createLessonJob, createMcqJob, listCreateJobs } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/create/jobs — every Create job, newest first (the page polls this for progress). */
export async function GET() {
	return Response.json({ jobs: listCreateJobs() });
}

/**
 * POST /api/create/jobs { kind?, lectureId, courseId?, sourceLectureId?, settings?, autostart? } — make a job
 * for a library PDF (kind "mcq" = MC test, the default; "cards" = flashcards) and (unless autostart
 * is false) start it; returns { job }. `sourceLectureId` is for MC tests only, `courseId` (the subject) for flashcards.
 * Kind "lesson" takes no PDF: { kind: "lesson", chatId? | nodeIds?, statementIds, courseId, settings?, autostart? } —
 * cards from the statements of a lesson (or of nodes picked on the graph) for the course.
 */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (body?.kind === "lesson") {
		try {
			const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
			const job = createLessonJob({
				chatId: typeof body.chatId === "string" && body.chatId ? body.chatId : undefined,
				nodeIds: strings(body.nodeIds),
				statementIds: strings(body.statementIds),
				courseId: typeof body.courseId === "string" ? body.courseId : "",
				settings: body.settings,
				autostart: body.autostart !== false,
			});
			return Response.json({ job });
		} catch (err) {
			if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
			throw err;
		}
	}
	if (!body || typeof body.lectureId !== "string") {
		return Response.json({ error: "lectureId is required" }, { status: 400 });
	}
	try {
		if (body.kind === "cards") {
			const job = await createCardsJob({ lectureId: body.lectureId, courseId: typeof body.courseId === "string" ? body.courseId : undefined, settings: body.settings, autostart: body.autostart !== false });
			return Response.json({ job });
		}
		if (body.kind !== undefined && body.kind !== "mcq") return Response.json({ error: "kind must be \"mcq\", \"cards\" or \"lesson\"" }, { status: 400 });
		const job = await createMcqJob({
			lectureId: body.lectureId,
			sourceLectureId: typeof body.sourceLectureId === "string" && body.sourceLectureId ? body.sourceLectureId : undefined,
			settings: body.settings,
			autostart: body.autostart !== false,
		});
		return Response.json({ job });
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
