/**
 * The Mac's list of courses, for the phone's choice (Learnbox 2.0, Slice 10g): what each would put on the phone. Asked
 * while the Mac can be reached; the list from the last update stands in otherwise (`PhoneMeta.catalog`).
 */

import { readPhoneCatalog } from "@/src/core";
import type { PhoneCatalogEntry } from "@/src/core";
import { PhoneApiError, phoneJson } from "./phone-http";

export async function fetchPhoneCatalog(): Promise<PhoneCatalogEntry[]> {
	const list = readPhoneCatalog(await phoneJson<unknown>("/api/phone/catalog"));
	if (!list) throw new PhoneApiError("The Mac sent something unexpected.", "server");
	return list;
}
