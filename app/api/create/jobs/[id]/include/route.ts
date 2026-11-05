import { CreateInputError } from "@/src/core";
import { createJobKind, setInclude, setLessonInclude } from "@/src/server";
import { bodyOf, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** POST /api/create/jobs/:id/include { cardIds: string[], include: boolean } — select or unselect many cards for adoption. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(async () => {
		const body = await bodyOf(req);
		if (!Array.isArray(body.cardIds) || typeof body.include !== "boolean") throw new CreateInputError("cardIds (list) and include (boolean) are required", 400);
		const cardIds = body.cardIds.filter((c): c is string => typeof c === "string");
		return { changed: (createJobKind(id) === "lesson" ? setLessonInclude : setInclude)(id, { cardIds, include: body.include }) };
	});
}
