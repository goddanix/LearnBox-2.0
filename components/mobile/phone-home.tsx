"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getPhoneToken, phoneFetch } from "./phone-auth";

/** The phone's start page. Slice 10a: it only confirms the pairing (10b brings the courses and the review). */
export function PhoneHome() {
	const router = useRouter();
	const [name, setName] = useState<string | null>(null);

	useEffect(() => {
		if (!getPhoneToken()) {
			router.replace("/m/pair");
			return;
		}
		let live = true;
		void phoneFetch("/m-api/me")
			.then(async (res) => {
				if (!res.ok) {
					router.replace("/m/pair");
					return;
				}
				const body = (await res.json()) as { device: { name: string } };
				if (live) setName(body.device.name);
			})
			.catch(() => {
				/* the Mac is not reachable: the offline app (10c) opens regardless */
			});
		return () => {
			live = false;
		};
	}, [router]);

	return (
		<main className="mx-auto flex w-full max-w-sm flex-col gap-3 px-4 py-10" data-testid="phone-home">
			<h1 className="font-title text-2xl">Learnbox</h1>
			<p className="text-sm text-muted-foreground">{name ? `Paired as ${name}.` : "Checking…"}</p>
		</main>
	);
}
