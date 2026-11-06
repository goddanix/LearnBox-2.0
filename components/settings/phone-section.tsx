"use client";
/**
 * The Phone section (Learnbox 2.0, Slice 10): study on the iPhone through Tailscale.
 *
 * Top to bottom the learner does it in order: switch phone access on (the gateway starts), let Tailscale share it
 * (one button that runs `tailscale serve` — the exact command is shown), show a pairing code and QR code, type the
 * code into the phone, and see (and lock) the paired phones. Nothing here runs a command on its own. A backup file
 * saved on a phone (Slice 10d) is read in at the bottom: the answers it holds are taken into the ledger, once.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { postJson, studyApi } from "@/components/study/api";
import { formatPairingCode, syncSummary } from "@/src/core";
import type { MobileDeviceSummary, MobileStatus, PairingOffer, PhoneSyncResult } from "@/src/core";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

const ADMIN_DNS = "https://login.tailscale.com/admin/dns";

/** A backup file is a few lines per answer; anything much bigger is not one of ours. */
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

/** The QR code as one SVG path (dark modules as 1×1 squares) with the quiet zone the scanner needs. */
function Qr({ rows }: { rows: string[] }) {
	const quiet = 4;
	const size = rows.length + quiet * 2;
	let d = "";
	rows.forEach((row, y) => {
		for (let x = 0; x < row.length; x++) if (row[x] === "1") d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
	});
	return (
		<svg viewBox={`0 0 ${size} ${size}`} className="size-40 shrink-0 rounded bg-white" role="img" aria-label="QR code that opens the phone app" shapeRendering="crispEdges" data-testid="phone-qr">
			<path d={d} fill="#000" />
		</svg>
	);
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");

function TailscaleLine({ status }: { status: MobileStatus }) {
	const { tailscale } = status;
	if (tailscale.state === "not-installed") return <>Tailscale is not installed on this Mac. Install it from tailscale.com and sign in.</>;
	if (tailscale.state === "needs-login") return <>Tailscale is installed but not signed in. Open its menu-bar icon and log in; do the same in the Tailscale app on the iPhone.</>;
	if (tailscale.state === "stopped") return <>Tailscale is switched off. Turn it on from its menu-bar icon.</>;
	if (tailscale.state === "unknown") return <>Learnbox could not read Tailscale's status.</>;
	if (!tailscale.httpsReady)
		return (
			<>
				Switch on MagicDNS and HTTPS Certificates in the{" "}
				<a href={ADMIN_DNS} target="_blank" rel="noreferrer" className="underline">
					Tailscale admin console
				</a>{" "}
				(DNS page). This Mac is {tailscale.host ?? "not named yet"}.
			</>
		);
	return <>Ready. This Mac is {tailscale.host} on your tailnet.</>;
}

export function PhoneSection() {
	const [status, setStatus] = useState<MobileStatus | null>(null);
	// The code on screen, and when it was shown: a phone paired after that moment used it, so the card goes away.
	const [shown, setShown] = useState<{ offer: PairingOffer; at: string } | null>(null);
	const offer = shown?.offer ?? null;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [backupNote, setBackupNote] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setStatus(await studyApi<MobileStatus>("/api/mobile"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// While a code is on screen, watch for the phone that uses it.
	useEffect(() => {
		if (!shown) return;
		const timer = setInterval(() => void load(), 2500);
		return () => clearInterval(timer);
	}, [shown, load]);
	useEffect(() => {
		if (shown && status?.devices.some((d) => d.createdAt >= shown.at)) setShown(null);
	}, [shown, status]);

	async function act<T>(run: () => Promise<T>, then?: (out: T) => void) {
		setBusy(true);
		setError(null);
		try {
			const out = await run();
			then?.(out);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	const setEnabled = (enabled: boolean) =>
		act(
			() => studyApi<MobileStatus>("/api/mobile", postJson({ enabled })),
			(next) => {
				setStatus(next);
				if (!enabled) setShown(null);
			},
		);
	const setServing = (on: boolean) => act(() => studyApi<MobileStatus>("/api/mobile/serve", postJson({ on })), setStatus);
	const showCode = () => act(
			() => studyApi<PairingOffer>("/api/mobile/pair", postJson({})),
			(next) => setShown({ offer: next, at: new Date().toISOString() }),
		);
	const lock = (d: MobileDeviceSummary) => act(() => studyApi(`/api/mobile/devices/${encodeURIComponent(d.id)}`, postJson({})));
	const forget = (d: MobileDeviceSummary) =>
		act(async () => {
			const res = await fetch(`/api/mobile/devices/${encodeURIComponent(d.id)}`, { method: "DELETE" });
			if (!res.ok) throw new Error(`Could not remove the phone (${res.status})`);
		});

	const readBackup = (file: File) =>
		act(
			async () => {
				if (file.size > MAX_BACKUP_BYTES) throw new Error("This is not a Learnbox phone backup file.");
				let parsed: unknown;
				try {
					parsed = JSON.parse(await file.text());
				} catch {
					throw new Error("This is not a Learnbox phone backup file.");
				}
				return studyApi<PhoneSyncResult>("/api/mobile/backup", postJson(parsed));
			},
			(result) => setBackupNote(syncSummary(result)),
		);

	if (!status) {
		return error ? (
			<p className="text-sm text-red-400" role="alert">
				{error}
			</p>
		) : (
			<p className="text-sm text-muted-foreground">Loading…</p>
		);
	}

	const serveCommand = `tailscale serve --bg --https=443 http://127.0.0.1:${status.port}`;
	return (
		<div className="flex flex-col gap-1" data-testid="phone-section">
			<SettingsRow label="Phone access" hint="Study your cards on the iPhone, with or without a connection to this Mac. Off until you switch it on.">
				<Toggle checked={status.enabled} disabled={busy} onChange={(next) => void setEnabled(next)} label="Phone access" />
			</SettingsRow>

			{error && (
				<p className="text-sm text-red-400" role="alert" data-testid="phone-error">
					{error}
				</p>
			)}

			<SettingsGroup label="Tailscale" testid="phone-tailscale">
				<p className="text-xs text-muted-foreground" data-testid="phone-tailscale-state">
					<TailscaleLine status={status} />
				</p>
				{status.tailscale.state === "running" && status.tailscale.httpsReady && (
					<>
						<SettingsRow label={status.serving ? "Shared on your tailnet" : "Share with Tailscale"} hint={status.serving ? status.url : <code className="text-[11px]">{serveCommand}</code>} dimmed={!status.enabled && !status.serving}>
							<Button
								variant="outline"
								size="sm"
								disabled={busy || (!status.enabled && !status.serving)}
								onClick={() => void setServing(!status.serving)}
								data-testid="phone-serve"
							>
								{status.serving ? "Stop sharing" : "Share"}
							</Button>
						</SettingsRow>
						<p className="text-xs text-muted-foreground/70">Only devices signed in to your Tailscale account can reach this address. Learnbox adds its own key per phone on top.</p>
					</>
				)}
			</SettingsGroup>

			<SettingsGroup label="Pair a phone" testid="phone-pair">
				{!offer ? (
					<SettingsRow label="Pairing code" hint="Shows a code and a QR code for one phone. It works once, for ten minutes." dimmed={!status.listening}>
						<Button variant="outline" size="sm" disabled={busy || !status.listening} onClick={() => void showCode()} data-testid="phone-show-code">
							Show code
						</Button>
					</SettingsRow>
				) : (
					<div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card p-4" data-testid="phone-offer">
						{offer.qr && <Qr rows={offer.qr} />}
						<div className="flex min-w-0 flex-col gap-1.5 text-sm">
							<span className="font-mono text-2xl tracking-widest" data-testid="phone-code">
								{formatPairingCode(offer.code)}
							</span>
							<span className="text-xs text-muted-foreground">Valid until {new Date(offer.expiresAt).toLocaleTimeString(undefined, { timeStyle: "short" })}, for one phone.</span>
							{offer.pairUrl ? (
								<ol className="mt-1 list-decimal pl-4 text-xs text-muted-foreground">
									<li>Scan the QR code with the iPhone's camera and open the link in Safari.</li>
									<li>Share → Add to Home Screen, then open the Learnbox 2.0 icon.</li>
									<li>Type the code above when the app asks for it.</li>
								</ol>
							) : (
								<p className="mt-1 text-xs text-muted-foreground">No phone address yet — finish the Tailscale steps above, then show a new code.</p>
							)}
							<div>
								<Button variant="ghost" size="xs" onClick={() => setShown(null)} data-testid="phone-hide-code">
									Hide
								</Button>
							</div>
						</div>
					</div>
				)}
			</SettingsGroup>

			<SettingsGroup label="Paired phones" testid="phone-devices">
				{status.devices.length === 0 && <p className="text-xs text-muted-foreground">No phone is paired yet.</p>}
				{status.devices.map((d) => (
					<SettingsRow key={d.id} label={d.name} hint={d.revoked ? "Locked — its key opens nothing" : `Paired ${when(d.createdAt)} · last used ${when(d.lastSeenAt)}`} testid="phone-device" dimmed={d.revoked}>
						<span className="flex gap-1">
							{!d.revoked && (
								<Button variant="outline" size="xs" disabled={busy} onClick={() => void lock(d)} data-testid="phone-lock">
									Lock
								</Button>
							)}
							<Button variant="ghost" size="xs" disabled={busy} onClick={() => void forget(d)} data-testid="phone-forget">
								Remove
							</Button>
						</span>
					</SettingsRow>
				))}
			</SettingsGroup>

			<SettingsGroup label="Backup file" testid="phone-backup-group">
				<SettingsRow label="Read a backup file" hint="The file a phone saved with “Save backup file”: the answers the Mac did not get are taken in. Reading the same file twice adds nothing.">
					<label className="inline-flex h-7 cursor-pointer items-center rounded-lg border px-2.5 text-[0.8rem] hover:bg-muted" data-testid="phone-backup-pick">
						Choose file…
						<input
							type="file"
							accept="application/json,.json"
							className="sr-only"
							disabled={busy}
							data-testid="phone-backup-input"
							onChange={(e) => {
								const file = e.target.files?.[0];
								e.target.value = "";
								setBackupNote(null);
								if (file) void readBackup(file);
							}}
						/>
					</label>
				</SettingsRow>
				{backupNote && (
					<p className="text-xs text-muted-foreground" role="status" data-testid="phone-backup-note">
						{backupNote}
					</p>
				)}
			</SettingsGroup>
		</div>
	);
}
