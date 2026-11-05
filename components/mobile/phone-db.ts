/**
 * The phone's own storage (Learnbox 2.0, Slice 10c): its copy of the courses and cards, every review it has seen (the
 * Mac's, and the ones given on the phone, marked until the Mac has them), and the media files the cards show. One
 * seam (`PhoneDb`), two implementations: IndexedDB for the phone, a plain in-memory one for tests.
 *
 * Nothing here knows about studying; the engine (phone-engine.ts) loads a snapshot into memory and writes back what
 * changes.
 */

import type { StudyCard, StudyCourse, StudyReview } from "@/src/core";

/** What the phone remembers about its copy. */
export interface PhoneMeta {
	v: 1;
	/** The Mac's clock when the deck was cut. */
	deckAt: string;
	/** This phone's clock when it last took the deck in. */
	syncedAt: string;
	/** How many lines of the Mac's review ledger the phone has taken in. */
	macReviews: number;
}

/** One review line the phone holds: `sent` is false for an answer given here that the Mac does not have yet. */
export interface ReviewRow {
	review: StudyReview;
	src: "mac" | "phone";
	sent: boolean;
}

export interface PhoneSnapshot {
	meta: PhoneMeta;
	courses: StudyCourse[];
	cards: StudyCard[];
	reviews: ReviewRow[];
}

export interface PhoneMediaFile {
	name: string;
	mime: string;
	bytes: ArrayBuffer;
}

export interface PhoneDb {
	/** Everything but the media, or null when no deck has been taken in yet. */
	load(): Promise<PhoneSnapshot | null>;
	/** Replace the courses and cards, add the Mac's new review lines, set the meta — all or nothing. */
	applyDeck(input: { meta: PhoneMeta; courses: readonly StudyCourse[]; cards: readonly StudyCard[]; macReviews: readonly StudyReview[] }): Promise<void>;
	/** Answers given on the phone, kept until the Mac has them. */
	addReviews(reviews: readonly StudyReview[]): Promise<void>;
	mediaNames(): Promise<string[]>;
	putMedia(file: PhoneMediaFile): Promise<void>;
	getMedia(names: readonly string[]): Promise<Map<string, PhoneMediaFile>>;
	deleteMedia(names: readonly string[]): Promise<void>;
	close(): void;
}

// ─── in memory (tests) ───────────────────────────────────────────────────────

export function createMemoryPhoneDb(): PhoneDb {
	let meta: PhoneMeta | null = null;
	let courses: StudyCourse[] = [];
	let cards: StudyCard[] = [];
	let reviews: ReviewRow[] = [];
	const media = new Map<string, PhoneMediaFile>();
	return {
		load: async () => (meta ? { meta, courses: [...courses], cards: [...cards], reviews: [...reviews] } : null),
		applyDeck: async (input) => {
			meta = input.meta;
			courses = [...input.courses];
			cards = [...input.cards];
			reviews.push(...input.macReviews.map((review): ReviewRow => ({ review, src: "mac", sent: true })));
		},
		addReviews: async (batch) => {
			reviews.push(...batch.map((review): ReviewRow => ({ review, src: "phone", sent: false })));
		},
		mediaNames: async () => [...media.keys()],
		putMedia: async (file) => void media.set(file.name, file),
		getMedia: async (names) => new Map(names.flatMap((n) => (media.has(n) ? [[n, media.get(n)!] as const] : []))),
		deleteMedia: async (names) => void names.forEach((n) => media.delete(n)),
		close: () => {},
	};
}

// ─── IndexedDB (the phone) ───────────────────────────────────────────────────

const DB_NAME = "learnbox-phone";
const DB_VERSION = 1;
const META_KEY = "meta";

const done = (tx: IDBTransaction): Promise<void> =>
	new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error("The phone's storage failed."));
		tx.onabort = () => reject(tx.error ?? new Error("The phone's storage was interrupted."));
	});
const result = <T>(request: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("The phone's storage failed."));
	});

export function openIndexedPhoneDb(factory: IDBFactory = indexedDB, name: string = DB_NAME): Promise<PhoneDb> {
	return new Promise((resolve, reject) => {
		const open = factory.open(name, DB_VERSION);
		open.onupgradeneeded = () => {
			const db = open.result;
			db.createObjectStore("meta");
			db.createObjectStore("courses", { keyPath: "id" });
			db.createObjectStore("cards", { keyPath: "id" });
			db.createObjectStore("reviews", { autoIncrement: true });
			db.createObjectStore("media", { keyPath: "name" });
		};
		open.onerror = () => reject(open.error ?? new Error("This browser cannot keep cards on the phone."));
		open.onblocked = () => reject(new Error("The phone's storage is busy; close other Learnbox windows and try again."));
		open.onsuccess = () => resolve(wrap(open.result));
	});
}

function wrap(db: IDBDatabase): PhoneDb {
	return {
		async load() {
			const tx = db.transaction(["meta", "courses", "cards", "reviews"], "readonly");
			const [meta, courses, cards, reviews] = await Promise.all([
				result(tx.objectStore("meta").get(META_KEY) as IDBRequest<PhoneMeta | undefined>),
				result(tx.objectStore("courses").getAll() as IDBRequest<StudyCourse[]>),
				result(tx.objectStore("cards").getAll() as IDBRequest<StudyCard[]>),
				result(tx.objectStore("reviews").getAll() as IDBRequest<ReviewRow[]>),
			]);
			return meta ? { meta, courses, cards, reviews } : null;
		},
		async applyDeck({ meta, courses, cards, macReviews }) {
			const tx = db.transaction(["meta", "courses", "cards", "reviews"], "readwrite");
			const done_ = done(tx);
			tx.objectStore("courses").clear();
			tx.objectStore("cards").clear();
			for (const c of courses) tx.objectStore("courses").put(c);
			for (const c of cards) tx.objectStore("cards").put(c);
			for (const review of macReviews) tx.objectStore("reviews").add({ review, src: "mac", sent: true } satisfies ReviewRow);
			tx.objectStore("meta").put(meta, META_KEY);
			await done_;
		},
		async addReviews(batch) {
			if (batch.length === 0) return;
			const tx = db.transaction("reviews", "readwrite");
			const done_ = done(tx);
			for (const review of batch) tx.objectStore("reviews").add({ review, src: "phone", sent: false } satisfies ReviewRow);
			await done_;
		},
		async mediaNames() {
			const tx = db.transaction("media", "readonly");
			return (await result(tx.objectStore("media").getAllKeys())) as string[];
		},
		async putMedia(file) {
			const tx = db.transaction("media", "readwrite");
			const done_ = done(tx);
			tx.objectStore("media").put(file);
			await done_;
		},
		async getMedia(names) {
			const out = new Map<string, PhoneMediaFile>();
			if (names.length === 0) return out;
			const tx = db.transaction("media", "readonly");
			const files = await Promise.all(names.map((n) => result(tx.objectStore("media").get(n) as IDBRequest<PhoneMediaFile | undefined>)));
			for (const f of files) if (f) out.set(f.name, f);
			return out;
		},
		async deleteMedia(names) {
			if (names.length === 0) return;
			const tx = db.transaction("media", "readwrite");
			const done_ = done(tx);
			for (const n of names) tx.objectStore("media").delete(n);
			await done_;
		},
		close: () => db.close(),
	};
}
