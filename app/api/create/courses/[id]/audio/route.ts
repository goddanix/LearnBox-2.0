import { defaultAudioDeps, getAudio } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** GET /api/create/courses/:id/audio — the audio summary of the course (script, audio), the run that is going on, the PDFs to choose from. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(() => ({ audio: getAudio(id, defaultAudioDeps()) }));
}
