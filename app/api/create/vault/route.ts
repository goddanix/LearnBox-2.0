import { setVaultPath, vaultInfo } from "@/src/server";
import { bodyOf, respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** GET /api/create/vault — where the Obsidian vault is, whether it exists, which course folders it has. */
export async function GET() {
	return respond(() => ({ vault: vaultInfo() }));
}

/** PUT /api/create/vault { path } — choose the vault's folder ("" = back to the default). */
export async function PUT(req: Request) {
	return respond(async () => ({ vault: setVaultPath((await bodyOf(req)).path) }));
}
