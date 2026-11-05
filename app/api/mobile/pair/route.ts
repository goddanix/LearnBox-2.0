import { mobileFailure } from "@/app/api/mobile/failure";
import { mobile } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/mobile/pair — a new pairing code (and its QR code) to show on the Mac. */
export async function POST() {
	try {
		return Response.json(await mobile().createPairing());
	} catch (err) {
		return mobileFailure(err);
	}
}
