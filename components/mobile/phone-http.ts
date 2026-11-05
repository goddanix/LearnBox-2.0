/**
 * The phone's calls to the Mac, through the gateway (Learnbox 2.0, Slice 10): the phone's key goes along, and every
 * way a call can fail becomes one of three kinds the screens understand.
 */

import { phoneFetch } from "./phone-auth";

/** unpaired: this phone's key is gone or locked · unreachable: no answer from the Mac · server: the Mac said no. */
export type PhoneApiErrorKind = "unpaired" | "unreachable" | "server";

export class PhoneApiError extends Error {
	constructor(
		message: string,
		readonly kind: PhoneApiErrorKind,
	) {
		super(message);
		this.name = "PhoneApiError";
	}
}

export const jsonInit = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** One call; anything but a 2xx answer is a PhoneApiError. */
export async function phoneCall(url: string, init?: RequestInit): Promise<Response> {
	let res: Response;
	try {
		res = await phoneFetch(url, init);
	} catch {
		throw new PhoneApiError("Cannot reach your Mac.", "unreachable");
	}
	if (res.status === 401) throw new PhoneApiError("This phone is not paired (any more).", "unpaired");
	// the Mac's own server being down is the gateway's 502
	if (res.status === 502) throw new PhoneApiError("Learnbox is not answering on your Mac.", "unreachable");
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new PhoneApiError(body?.error ?? `Request failed (${res.status})`, "server");
	}
	return res;
}

export async function phoneJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await phoneCall(url, init);
	try {
		return (await res.json()) as T;
	} catch {
		throw new PhoneApiError("The Mac sent something unexpected.", "server");
	}
}
