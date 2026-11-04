import { CreateInputError } from "@/src/core";

/** Runs a Create route's work: its result as JSON, a refused request as its status and message. */
export async function respond(work: () => unknown | Promise<unknown>): Promise<Response> {
	try {
		return Response.json(await work());
	} catch (err) {
		if (err instanceof CreateInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

/** The JSON object of a request body; a missing or odd body is a 400. */
export async function bodyOf(req: Request): Promise<Record<string, unknown>> {
	const body: unknown = await req.json().catch(() => null);
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new CreateInputError("A JSON object is required", 400);
	return body as Record<string, unknown>;
}

/** A page number from a route segment. */
export function pageParam(value: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) throw new CreateInputError("Unknown page", 404);
	return n;
}
