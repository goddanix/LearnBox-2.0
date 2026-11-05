"use client";

import { useEffect, useState } from "react";

/**
 * Whether the browser says it has a connection. Only a hint: it cannot tell whether the Mac is awake and reachable
 * (a failed call says that), but it greys out what needs the Mac the moment the phone is clearly offline.
 */
export function useOnline(): boolean {
	const [online, setOnline] = useState(true);
	useEffect(() => {
		const sync = () => setOnline(navigator.onLine !== false);
		sync();
		window.addEventListener("online", sync);
		window.addEventListener("offline", sync);
		return () => {
			window.removeEventListener("online", sync);
			window.removeEventListener("offline", sync);
		};
	}, []);
	return online;
}
