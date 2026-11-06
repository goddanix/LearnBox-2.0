"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { normalizePairingCode } from "@/src/core";
import { phoneFetch, restorePhoneToken, setPhoneToken } from "./phone-auth";

/**
 * Pairing, on the phone: the eight-character code shown on the Mac (the QR code only carries it to this page) and a
 * name for this phone. The code is used here, inside the app the learner will keep using, so the key lands in this
 * app's own storage — Safari and an installed web app do not share any.
 *
 * A phone that is paired already never sees the form: the home-screen icon may well open this address (iOS keeps the
 * page the icon was made from), and asking for a code again there would unpair the phone in the learner's eyes.
 */
export function PairForm({ initialCode = "" }: { initialCode?: string }) {
	const router = useRouter();
	const [code, setCode] = useState(initialCode);
	const [name, setName] = useState("iPhone");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** Looking for a key this phone already has, before anything is asked of the learner. */
	const [checking, setChecking] = useState(true);

	useEffect(() => {
		let live = true;
		void (async () => {
			if (!(await restorePhoneToken())) {
				if (live) setChecking(false);
				return;
			}
			try {
				// the Mac is asked only to see whether the key was locked; no answer at all is no reason to ask for a code
				const res = await phoneFetch("/m-api/me");
				if (res.status === 401) {
					if (live) setChecking(false);
					return;
				}
			} catch {
				/* the Mac cannot be reached: the key stands */
			}
			if (live) router.replace("/m");
		})();
		return () => {
			live = false;
		};
	}, [router]);

	async function submit() {
		const normalized = normalizePairingCode(code);
		if (!normalized) {
			setError("The code has eight letters and digits, like ABCD-2345.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/m-api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: normalized, name }) });
			const body = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
			if (!res.ok || !body?.token) throw new Error(body?.error ?? `Pairing failed (${res.status})`);
			setPhoneToken(body.token);
			router.replace("/m");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	}

	if (checking) return <p className="px-4 py-10 text-sm text-muted-foreground" data-testid="pair-checking">Loading…</p>;

	return (
		<form
			className="mx-auto flex w-full max-w-sm flex-col gap-4 px-4 py-10"
			data-testid="pair-form"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<h1 className="font-title text-2xl">Learnbox 2.0</h1>
			<p className="text-sm text-muted-foreground">
				Pair this phone with your Mac. On the Mac, open Settings → Phone → Show code, then type the code here.
			</p>
			<label className="flex flex-col gap-1 text-xs text-muted-foreground">
				Pairing code
				<input
					value={code}
					onChange={(e) => setCode(e.target.value)}
					autoCapitalize="characters"
					autoCorrect="off"
					autoComplete="off"
					spellCheck={false}
					inputMode="text"
					placeholder="ABCD-2345"
					className="h-12 rounded-md border bg-background px-3 font-mono text-xl tracking-widest text-foreground"
					data-testid="pair-code"
				/>
			</label>
			<label className="flex flex-col gap-1 text-xs text-muted-foreground">
				Name of this phone
				<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="h-11 rounded-md border bg-background px-3 text-base text-foreground" data-testid="pair-name" />
			</label>
			{error && (
				<p className="text-sm text-red-400" role="alert" data-testid="pair-error">
					{error}
				</p>
			)}
			<button type="submit" disabled={busy} className="h-12 rounded-md bg-foreground text-base font-medium text-background disabled:opacity-50" data-testid="pair-submit">
				{busy ? "Pairing…" : "Pair"}
			</button>
		</form>
	);
}
