import { defaultNotesDeps, saveToVault } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** POST /api/create/courses/:id/notes/save — write the selected notes into the Obsidian vault (what the reader wrote under "Eigene Notizen" stays). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(() => ({ saved: saveToVault(id, defaultNotesDeps()) }));
}
