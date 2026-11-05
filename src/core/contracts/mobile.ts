/**
 * Phone access (Learnbox 2.0, Slice 10): the Mac serves a narrow "gateway" for the learner's iPhone. The phone is
 * paired once (a short code, shown as a QR code in Settings → Phone), then carries its own key. Everything here is
 * plain data; the rules live in core/mobile.ts, the files in store/mobile.ts, the listener in server/mobile-gateway.ts.
 */

export const MOBILE_SCHEMA = 1;

/** The gateway's fixed port on 127.0.0.1 (Tailscale Serve forwards the tailnet's https to it). */
export const MOBILE_DEFAULT_PORT = 47831;

/** A pairing code is valid this long and for one phone only. */
export const PAIRING_TTL_MS = 10 * 60_000;
/** Wrong guesses an offer survives: the fifth one burns it. */
export const PAIRING_MAX_FAILURES = 5;
/** Pairing offers that may be open at once (a new one beyond this replaces the oldest). */
export const PAIRING_MAX_OFFERS = 3;
/** No 0/O/1/I: the code is read off a screen and typed. */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;

export const DEVICE_NAME_MAX = 40;
export const DEVICE_NAME_DEFAULT = "iPhone";

/** data/mobile/config.json */
export interface MobileConfig {
	v: typeof MOBILE_SCHEMA;
	/** The learner switched phone access on (the gateway starts with the app). */
	enabled: boolean;
	port: number;
}

/** One paired phone, as stored. The key itself is never stored: only its SHA-256. */
export interface MobileDevice {
	id: string;
	name: string;
	tokenHash: string;
	createdAt: string;
	lastSeenAt?: string;
	/** Locked by the learner: the key no longer opens anything. */
	revokedAt?: string;
}

/** What the Settings list may see of a device (never the hash). */
export interface MobileDeviceSummary {
	id: string;
	name: string;
	createdAt: string;
	lastSeenAt?: string;
	revoked: boolean;
}

export type TailscaleStateName = "not-installed" | "needs-login" | "stopped" | "running" | "unknown";

export interface TailscaleState {
	state: TailscaleStateName;
	/** This Mac's name on the tailnet (MagicDNS), without the trailing dot. */
	host?: string;
	/** Tailscale can issue https certificates for `host` (HTTPS is switched on in its admin console). */
	httpsReady: boolean;
}

export interface MobileStatus {
	enabled: boolean;
	port: number;
	/** The gateway is accepting connections right now. */
	listening: boolean;
	tailscale: TailscaleState;
	/** Tailscale Serve forwards its https to the gateway. */
	serving: boolean;
	/** The address the phone opens (https://<host>), when there is one. */
	url?: string;
	devices: MobileDeviceSummary[];
}

/** A pairing code to show on the Mac: typed into the phone app, or scanned as a QR code that opens the install page. */
export interface PairingOffer {
	/** Displayed as ABCD-EFGH; stored and compared without the dash. */
	code: string;
	expiresAt: string;
	/** The page the QR code opens (needs the phone address, so absent until Tailscale is ready). */
	pairUrl?: string;
	/** The QR code's modules, one string of "0"/"1" per row. */
	qr?: string[];
}
