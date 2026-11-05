import { defaultNotesDeps, rewriteTopic, updateNote } from "@/src/server";
import { bodyOf, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** PUT /api/create/courses/:id/notes/:item { markdown?, include? } — change a written note's text, or whether it goes into the vault. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string; item: string }> }) {
	const { id, item } = await params;
	return respond(async () => ({ item: updateNote(id, item, await bodyOf(req), defaultNotesDeps()) }));
}

/** POST /api/create/courses/:id/notes/:item — write one topic's note again (in the background; poll GET on the note set). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; item: string }> }) {
	const { id, item } = await params;
	return respond(() => ({ started: rewriteTopic(id, item, defaultNotesDeps()) }));
}
