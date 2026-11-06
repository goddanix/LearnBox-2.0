/**
 * The phone's key (Learnbox 2.0, Slice 10): handed out once by the gateway when a pairing code is used, kept in this
 * browser's storage, sent as `Authorization: Bearer` on every request to the gateway. Storage can be refused or
 * emptied (private window, iOS clearing a web app); every access is guarded and "no key" is a normal answer.
 *
 * The key is kept twice: in localStorage (read synchronously, the first thing a page needs) and in a tiny database of
 * its own in IndexedDB. If one of them is emptied the other puts it back (`restorePhoneToken`), so a phone that lost
 * only half of its storage does not have to be paired again.
 */

const KEY = "lh-phone-token";

/** The second copy of the key. Its own seam so tests can use a plain in-memory one. */
export interface KeyVault {
	read(): Promise<string | null>;
	write(token: string): Promise<void>;
	remove(): Promise<void>;
}

const VAULT_DB = "learnbox-phone-key";
const VAULT_STORE = "kv";

/** The key vault in IndexedDB; any failure (no IndexedDB, refused, blocked) is "nothing there" and a silent no-op. */
export function indexedKeyVault(factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB): KeyVault {
	const open = (): Promise<IDBDatabase> =>
		new Promise((resolve, reject) => {
			if (!factory) return reject(new Error("no IndexedDB"));
			const request = factory.open(VAULT_DB, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(VAULT_STORE);
			request.onerror = () => reject(request.error ?? new Error("IndexedDB failed"));
			request.onblocked = () => reject(new Error("IndexedDB is blocked"));
			request.onsuccess = () => resolve(request.result);
		});
	const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> => {
		try {
			const db = await open();
			try {
				return await new Promise<T>((resolve, reject) => {
					const tx = db.transaction(VAULT_STORE, mode);
					const request = work(tx.objectStore(VAULT_STORE));
					tx.oncomplete = () => resolve(request.result);
					tx.onerror = () => reject(tx.error ?? new Error("IndexedDB failed"));
					tx.onabort = () => reject(tx.error ?? new Error("IndexedDB was interrupted"));
				});
			} finally {
				db.close();
			}
		} catch {
			return null;
		}
	};
	return {
		read: async () => {
			const value = await run("readonly", (s) => s.get("token") as IDBRequest<unknown>);
			return typeof value === "string" && value.length > 0 ? value : null;
		},
		write: async (token) => void (await run("readwrite", (s) => s.put(token, "token"))),
		remove: async () => void (await run("readwrite", (s) => s.delete("token"))),
	};
}

let vault: KeyVault = indexedKeyVault();
/** Tests give the keys another second copy. */
export function useKeyVault(next: KeyVault): void {
	vault = next;
}

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
	void vault.write(token).catch(() => {});
}

export function clearPhoneToken(): void {
	try {
		localStorage.removeItem(KEY);
	} catch {
		/* nothing stored */
	}
	void vault.remove().catch(() => {});
}

/**
 * The key this phone holds, if either copy still has it. When only the second copy has it, it goes back into
 * localStorage, so everything else keeps reading the key synchronously.
 */
export async function restorePhoneToken(): Promise<string | null> {
	const have = getPhoneToken();
	if (have) {
		// make sure the second copy is there too (a phone paired before it existed has none)
		void vault.write(have).catch(() => {});
		return have;
	}
	let saved: string | null = null;
	try {
		saved = await vault.read();
	} catch {
		saved = null;
	}
	if (!saved) return null;
	try {
		localStorage.setItem(KEY, saved);
	} catch {
		/* the key is good for this page only */
	}
	return saved;
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
