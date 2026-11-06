/**
 * How safe the phone's own copy is (Learnbox 2.0, Slice 10g): asks the browser to keep the app's storage when the
 * phone runs short of space, and says whether it promised to. A web app's storage on iOS can be cleared by the system;
 * "kept" means the browser agreed not to, "may be cleared" means it did not (or cannot say).
 */

import { useEffect, useState } from "react";

export interface PhoneStorageStatus {
	/** true: the browser promised to keep the storage · false: it did not · null: it cannot say (no storage API). */
	persistent: boolean | null;
	/** What the app's storage uses and may use, in bytes, when the browser says. */
	usage?: number;
	quota?: number;
}

/** The slice of `navigator.storage` this needs, so a test can stand in for it. */
export type StorageApi = Pick<StorageManager, "persist" | "persisted" | "estimate">;

/**
 * Ask for persistent storage (once is enough; browsers answer the same again) and read the answer back. Never throws:
 * a browser without the API, or one that refuses, is `persistent: null` / `false`.
 */
export async function requestPersistentStorage(api: Partial<StorageApi> | undefined = typeof navigator === "undefined" ? undefined : navigator.storage): Promise<PhoneStorageStatus> {
	if (!api) return { persistent: null };
	let persistent: boolean | null = null;
	try {
		if (typeof api.persisted === "function") persistent = await api.persisted();
		if (persistent !== true && typeof api.persist === "function") persistent = await api.persist();
	} catch {
		/* refused: whatever is known stays */
	}
	const out: PhoneStorageStatus = { persistent };
	try {
		const estimate = typeof api.estimate === "function" ? await api.estimate() : undefined;
		if (estimate && typeof estimate.usage === "number") out.usage = estimate.usage;
		if (estimate && typeof estimate.quota === "number") out.quota = estimate.quota;
	} catch {
		/* no numbers */
	}
	return out;
}

/** "12 MB" · "1.4 GB" — for the storage line. */
export function formatBytes(bytes: number): string {
	if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
	if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
	return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** The storage status, asked for once when the app starts. */
export function usePhoneStorage(request: () => Promise<PhoneStorageStatus> = requestPersistentStorage): PhoneStorageStatus | null {
	const [status, setStatus] = useState<PhoneStorageStatus | null>(null);
	useEffect(() => {
		let live = true;
		void request().then((s) => live && setStatus(s));
		return () => {
			live = false;
		};
	}, [request]);
	return status;
}
