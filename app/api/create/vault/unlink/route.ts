import { unlinkNotes } from "@/src/server";
import { respond } from "@/app/api/create/respond";

export const dynamic = "force-dynamic";

/** POST /api/create/vault/unlink — take every "Verwandte Themen" section out of the notes the app wrote. */
export async function POST() {
	return respond(() => ({ removed: unlinkNotes() }));
}
