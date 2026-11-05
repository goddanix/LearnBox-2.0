import * as fs from "node:fs";
import { Readable } from "node:stream";
import { byteRange, CreateInputError } from "@/src/core";
import { audioFile, defaultAudioDeps } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/create/courses/:id/audio/file — the MP3 of the summary (with byte ranges, so the player can wind). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const { file, size } = audioFile(id, defaultAudioDeps());
		const headers = { "content-type": "audio/mpeg", "accept-ranges": "bytes", "cache-control": "private, no-cache" };
		const range = byteRange(req.headers.get("range"), size);
		if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
		const [start, end] = range ? [range.start, range.end] : [0, size - 1];
		const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
		return new Response(body, {
			status: range ? 206 : 200,
			headers: { ...headers, "content-length": String(end - start + 1), ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) },
		});
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
