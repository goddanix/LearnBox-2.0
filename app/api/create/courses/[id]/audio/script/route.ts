import { CreateInputError } from "@/src/core";
import { defaultAudioDeps, startScript, updateScript } from "@/src/server";
import { bodyOf, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** POST /api/create/courses/:id/audio/script { jobIds: string[] } — Claude writes the script from the chosen PDFs (in the background, free of ElevenLabs credit; poll GET). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(async () => {
		const body = await bodyOf(req);
		if (!startScript(id, { jobIds: body.jobIds }, defaultAudioDeps())) throw new CreateInputError("Something is going on for this course already — please wait.", 409);
		return { started: true };
	});
}

/** PUT /api/create/courses/:id/audio/script { title?, script? } — change the title or the script by hand (a changed script drops its audio). */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return respond(async () => ({ audio: updateScript(id, await bodyOf(req), defaultAudioDeps()) }));
}
