import { defaultAudioDeps, setVoice } from "@/src/server";
import { bodyOf, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** PUT /api/create/audio/voice { voiceId: string | null } — the voice of the audio summaries (null or "": back to the default). */
export async function PUT(req: Request) {
	return respond(async () => ({ voiceId: setVoice((await bodyOf(req)).voiceId, defaultAudioDeps()) }));
}
