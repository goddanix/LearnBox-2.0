/**
 * Phone access (Learnbox 2.0, Slice 10): the Mac serves a narrow "gateway" for the learner's iPhone. The phone is
 * paired once (a short code, shown as a QR code in Settings → Phone), then carries its own key. Everything here is
 * plain data; the rules live in core/mobile.ts, the files in store/mobile.ts, the listener in server/mobile-gateway.ts.
 */

import type { StudyCard, StudyCourse, StudyReview } from "./study.ts";

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

// ─── the phone's own copy of the cards (Slice 10c) ───────────────────────────

export const PHONE_DECK_SCHEMA = 1;

/** One media file a card needs, as the Mac holds it. */
export interface PhoneMediaEntry {
	name: string;
	size: number;
}

/** One course as the phone's choice lists it (Slice 10g): what taking it would put on the phone. */
export interface PhoneCatalogEntry {
	id: string;
	name: string;
	/** Live cards in the course. */
	cards: number;
	/** Bytes of the pictures and sounds those cards use (what the Mac has of them). */
	mediaBytes: number;
}

/** GET /api/phone/catalog: every course on the Mac, so the phone can offer a choice before it takes anything. */
export interface PhoneCatalog {
	v: typeof PHONE_DECK_SCHEMA;
	courses: PhoneCatalogEntry[];
}

/**
 * What the Mac hands a phone to study from (GET /api/phone/deck[?courses=a,b]): the chosen courses (all, when none are
 * named) with their live cards, the review ledger from where the phone stopped — only the lines of those cards — and
 * the list of media files the cards ask for (fetched one by one, GET /api/phone/media/…).
 */
export interface PhoneDeck {
	v: typeof PHONE_DECK_SCHEMA;
	/** The Mac's clock when the deck was cut. */
	at: string;
	courses: StudyCourse[];
	cards: StudyCard[];
	/** Review lines of the Mac's ledger from this index on (append order)… */
	reviewsFrom: number;
	reviews: StudyReview[];
	/** …and how many lines the ledger holds in all: the phone asks from here next time. */
	reviewsTotal: number;
	media: PhoneMediaEntry[];
	/** Every course on the Mac, chosen or not (absent in decks cut before Slice 10g). */
	catalog?: PhoneCatalogEntry[];
}

// ─── answers going back to the Mac (Slice 10d) ───────────────────────────────

export const PHONE_BACKUP_SCHEMA = 1;
export const PHONE_BACKUP_KIND = "learnbox-phone-backup";

/** What the learner can do to a card on the phone besides answering it (same names as the Mac's card actions). */
export type PhoneCardAction = "suspend" | "unsuspend" | "bury" | "unbury" | "edit";

/**
 * One change made to a card on the phone (Slice 10e), kept until the Mac has it. `at` is the phone's clock when the
 * learner made it: the Mac takes it in only if the card was not changed there after that moment (the newer wins).
 */
export interface PhoneCardOp {
	cardId: string;
	action: PhoneCardAction;
	at: string;
	/** For `edit`: the fields that changed, by name, with their new text. */
	fields?: Record<string, string>;
}

/** The file the phone saves: the answers and card changes the Mac does not have yet. Importable on the phone and on the Mac. */
export interface PhoneBackup {
	v: typeof PHONE_BACKUP_SCHEMA;
	kind: typeof PHONE_BACKUP_KIND;
	createdAt: string;
	/** The phone's name, for the learner's own eyes. */
	device?: string;
	reviews: StudyReview[];
	/** Card changes (pause, bury, edit) not yet on the Mac. Absent in files from before Slice 10e. */
	ops?: PhoneCardOp[];
}

/** What the Mac did with card changes it was sent. */
export interface PhoneCardChangesResult {
	/** Changes made to the Mac's cards now. */
	applied: number;
	/** Changes the Mac had already taken in (same change, sent again). */
	known: number;
	/** Changes left out because the card was changed on the Mac after the learner made them on the phone. */
	newerOnMac: number;
	/** Changes for cards that no longer exist. */
	unknownCards: number;
	/** Changes that were not valid (not a change, a field the card does not have, …). */
	rejected: number;
}

/** What the Mac did with review lines it was sent (POST /api/phone/sync) or read from a backup file. */
export interface PhoneSyncResult {
	/** Lines new to the ledger, now in it. */
	added: number;
	/** Lines the ledger already held. */
	known: number;
	/** Lines for cards that no longer exist. */
	unknownCards: number;
	/** Entries that were not review lines. */
	rejected: number;
	/** Lines in the ledger now: the phone asks for the deck from here next time. */
	reviewsTotal: number;
	/** What happened to the card changes that came with them (Slice 10e). */
	cardChanges: PhoneCardChangesResult;
}

/** One lesson as the phone lists it (GET /api/phone/lessons): enough to find it again and see whether it waits for an answer. */
export interface PhoneLesson {
	id: string;
	title: string;
	updatedAt: string;
	/** Claude is writing a reply on the Mac right now. */
	busy: boolean;
	/** A question is waiting for the learner. */
	pendingQuestion: boolean;
}
