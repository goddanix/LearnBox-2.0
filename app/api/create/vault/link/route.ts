import { linkStatus, startLink } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** GET /api/create/vault/link — how far the linking of the vault is, and what the last run came to. */
export async function GET() {
	return respond(() => ({ link: linkStatus() }));
}

/** POST /api/create/vault/link { llm? } — link the notes of the vault to related ones (in the background; poll GET). `llm: false` chooses by similarity alone. */
export async function POST(req: Request) {
	const body: unknown = await req.json().catch(() => null);
	const llm = typeof body === "object" && body !== null && (body as { llm?: unknown }).llm === false ? false : true;
	return respond(() => ({ started: startLink({ llm }) }));
}
