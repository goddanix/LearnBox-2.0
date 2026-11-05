import { defaultNotesDeps, getNotes, startNotes } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** GET /api/create/courses/:id/notes — the Obsidian note set of the course (one note per topic) and the progress of a run that is going on. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(() => ({ notes: getNotes(id, defaultNotesDeps()) }));
}

/** POST /api/create/courses/:id/notes — write the topic notes of the course (in the background; poll GET). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(() => ({ started: startNotes(id, defaultNotesDeps()) }));
}
