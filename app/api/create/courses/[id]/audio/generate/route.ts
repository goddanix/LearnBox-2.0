import { CreateInputError } from "@/src/core";
import { defaultAudioDeps, startAudio } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** POST /api/create/courses/:id/audio/generate — the MP3 of the current script through ElevenLabs (in the background; it costs ElevenLabs credit, so only on a click; poll GET). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(() => {
		if (!startAudio(id, defaultAudioDeps())) throw new CreateInputError("Something is going on for this course already — please wait.", 409);
		return { started: true };
	});
}
