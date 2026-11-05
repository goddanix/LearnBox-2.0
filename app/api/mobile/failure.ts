import { MobileError } from "@/src/server";

/** A service failure → its HTTP answer; a port that is taken is the one system error worth naming. */
export function mobileFailure(err: unknown): Response {
	if (err instanceof MobileError) return Response.json({ error: err.message }, { status: err.status });
	if (err instanceof Error && (err as { code?: string }).code === "EADDRINUSE") {
		return Response.json({ error: "The phone gateway's port is already in use on this Mac." }, { status: 409 });
	}
	throw err;
}
