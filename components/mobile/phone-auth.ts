/**
 * The phone's key (Learnbox 2.0, Slice 10): handed out once by the gateway when a pairing code is used, kept in this
 * browser's storage, sent as `Authorization: Bearer` on every request to the gateway. Storage can be refused or
 * emptied (private window, iOS clearing a web app); every access is guarded and "no key" is a normal answer.
 */

const KEY = "lh-phone-token";

export function getPhoneToken(): string | null {
	try {
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
}

export function setPhoneToken(token: string): void {
	try {
		localStorage.setItem(KEY, token);
	} catch {
		/* the key lives for this page only; the learner pairs again next time */
	}
}

export function clearPhoneToken(): void {
	try {
		localStorage.removeItem(KEY);
	} catch {
		/* nothing stored */
	}
}

/** fetch with this phone's key; on a 401 the key is dropped (the learner locked this phone, or it was never good). */
export async function phoneFetch(url: string, init: RequestInit = {}): Promise<Response> {
	const token = getPhoneToken();
	const headers = new Headers(init.headers);
	if (token) headers.set("Authorization", `Bearer ${token}`);
	const res = await fetch(url, { ...init, headers });
	if (res.status === 401) clearPhoneToken();
	return res;
}
