/**
 * The phone's own storage (Learnbox 2.0, Slice 10c): its copy of the courses and cards, every review it has seen (the
 * Mac's, and the ones given on the phone, marked until the Mac has them), the card changes made on the phone (pause,
 * bury, edit — likewise marked), and the media files the cards show. One seam (`PhoneDb`), two implementations:
 * IndexedDB for the phone, a plain in-memory one for tests.
 *
 * Nothing here knows about studying; the engine (phone-engine.ts) loads a snapshot into memory and writes back what
 * changes.
 */

import { newOps, newReviews, opKey, reviewKey } from "@/src/core";
import type { PhoneCardOp, PhoneCatalogEntry, StudyCard, StudyCourse, StudyReview } from "@/src/core";

/** What the phone remembers about its copy. */
export interface PhoneMeta {
	v: 1;
	/** The Mac's clock when the deck was cut. */
	deckAt: string;
	/** This phone's clock when it last took the deck in. */
	syncedAt: string;
	/** How many lines of the Mac's review ledger the phone has taken in. */
	macReviews: number;
	/** The courses the learner chose to hold here (Slice 10g). Absent on a phone that took everything before the choice existed. */
	courses?: string[];
	/** Every course on the Mac as of the last update: the list the choice is made from (absent before Slice 10g). */
	catalog?: PhoneCatalogEntry[];
}

/** The ids of the courses this phone holds: the learner's choice, or — for a phone from before the choice existed — all it has. */
export function heldCourseIds(snap: Pick<PhoneSnapshot, "meta" | "courses">): string[] {
	return snap.meta.courses ?? snap.courses.map((c) => c.id);
}

/** One review line the phone holds: `sent` is false for an answer given here that the Mac does not have yet. */
export interface ReviewRow {
	review: StudyReview;
	src: "mac" | "phone";
	sent: boolean;
}

/** One card change the phone holds: `sent` is false until the Mac has taken it in. */
export interface OpRow {
	op: PhoneCardOp;
	sent: boolean;
}

export interface PhoneSnapshot {
	meta: PhoneMeta;
	courses: StudyCourse[];
	cards: StudyCard[];
	reviews: ReviewRow[];
	ops: OpRow[];
}

export interface PhoneMediaFile {
	name: string;
	mime: string;
	bytes: ArrayBuffer;
}

export interface PhoneDb {
	/** Everything but the media, or null when no deck has been taken in yet. */
	load(): Promise<PhoneSnapshot | null>;
	/**
	 * Replace the courses and cards, add the Mac's new review lines, set the meta — all or nothing. Card changes the Mac
	 * has are let go, and so are the review lines of cards that are no longer in the deck (a course the learner took off
	 * the phone) — except answers the Mac does not have yet, which stay.
	 */
	applyDeck(input: { meta: PhoneMeta; courses: readonly StudyCourse[]; cards: readonly StudyCard[]; macReviews: readonly StudyReview[] }): Promise<void>;
	/** Answers given on the phone, kept until the Mac has them. */
	addReviews(reviews: readonly StudyReview[]): Promise<void>;
	/** The answers the Mac does not have yet, oldest first. */
	unsentReviews(): Promise<StudyReview[]>;
	/** The Mac has taken these in (matched by what the line is, not by position). */
	markSent(reviews: readonly StudyReview[]): Promise<void>;
	/** Answers from a backup file: the ones this phone does not hold yet are kept as not-yet-sent. Says how many were new. */
	importReviews(reviews: readonly StudyReview[]): Promise<number>;
	/** A card change made on the phone: the cards it rewrote and the change itself, kept together — all or nothing. */
	addCardChange(op: PhoneCardOp, cards: readonly StudyCard[]): Promise<void>;
	/** The card changes the Mac does not have yet, oldest first. */
	unsentOps(): Promise<PhoneCardOp[]>;
	/** The Mac has taken these in (matched by what the change is, not by position). */
	markOpsSent(ops: readonly PhoneCardOp[]): Promise<void>;
	/** Card changes from a backup file: the ones this phone does not hold yet are kept as not-yet-sent. Says how many were new. */
	importOps(ops: readonly PhoneCardOp[]): Promise<number>;
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
	let ops: OpRow[] = [];
	const media = new Map<string, PhoneMediaFile>();
	return {
		load: async () => (meta ? { meta, courses: [...courses], cards: [...cards], reviews: [...reviews], ops: [...ops] } : null),
		applyDeck: async (input) => {
			const held = new Set(input.cards.map((c) => c.id));
			meta = input.meta;
			courses = [...input.courses];
			cards = [...input.cards];
			reviews = reviews.filter((r) => !r.sent || held.has(r.review.cardId));
			reviews.push(...input.macReviews.filter((r) => held.has(r.cardId)).map((review): ReviewRow => ({ review, src: "mac", sent: true })));
			ops = ops.filter((o) => !o.sent);
		},
		addReviews: async (batch) => {
			reviews.push(...batch.map((review): ReviewRow => ({ review, src: "phone", sent: false })));
		},
		unsentReviews: async () => reviews.filter((r) => !r.sent).map((r) => r.review),
		markSent: async (batch) => {
			const keys = new Set(batch.map(reviewKey));
			reviews = reviews.map((r) => (!r.sent && keys.has(reviewKey(r.review)) ? { ...r, sent: true } : r));
		},
		importReviews: async (batch) => {
			const fresh = newReviews(reviews.map((r) => r.review), batch);
			reviews.push(...fresh.map((review): ReviewRow => ({ review, src: "phone", sent: false })));
			return fresh.length;
		},
		addCardChange: async (op, changed) => {
			const byId = new Map(changed.map((c) => [c.id, c]));
			cards = cards.map((c) => byId.get(c.id) ?? c);
			ops.push({ op, sent: false });
		},
		unsentOps: async () => ops.filter((o) => !o.sent).map((o) => o.op),
		markOpsSent: async (batch) => {
			const keys = new Set(batch.map(opKey));
			ops = ops.map((o) => (!o.sent && keys.has(opKey(o.op)) ? { ...o, sent: true } : o));
		},
		importOps: async (batch) => {
			const fresh = newOps(ops.map((o) => o.op), batch);
			ops.push(...fresh.map((op): OpRow => ({ op, sent: false })));
			return fresh.length;
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
const DB_VERSION = 2;
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
		open.onupgradeneeded = (event) => {
			const db = open.result;
			if (event.oldVersion < 1) {
				db.createObjectStore("meta");
				db.createObjectStore("courses", { keyPath: "id" });
				db.createObjectStore("cards", { keyPath: "id" });
				db.createObjectStore("reviews", { autoIncrement: true });
				db.createObjectStore("media", { keyPath: "name" });
			}
			// Slice 10e: the card changes made on the phone; a phone that already holds a deck keeps everything it has
			if (event.oldVersion < 2) db.createObjectStore("ops", { autoIncrement: true });
		};
		open.onerror = () => reject(open.error ?? new Error("This browser cannot keep cards on the phone."));
		open.onblocked = () => reject(new Error("The phone's storage is busy; close other Learnbox windows and try again."));
		open.onsuccess = () => resolve(wrap(open.result));
	});
}

function wrap(db: IDBDatabase): PhoneDb {
	return {
		async load() {
			const tx = db.transaction(["meta", "courses", "cards", "reviews", "ops"], "readonly");
			const [meta, courses, cards, reviews, ops] = await Promise.all([
				result(tx.objectStore("meta").get(META_KEY) as IDBRequest<PhoneMeta | undefined>),
				result(tx.objectStore("courses").getAll() as IDBRequest<StudyCourse[]>),
				result(tx.objectStore("cards").getAll() as IDBRequest<StudyCard[]>),
				result(tx.objectStore("reviews").getAll() as IDBRequest<ReviewRow[]>),
				result(tx.objectStore("ops").getAll() as IDBRequest<OpRow[]>),
			]);
			return meta ? { meta, courses, cards, reviews, ops } : null;
		},
		async applyDeck({ meta, courses, cards, macReviews }) {
			const tx = db.transaction(["meta", "courses", "cards", "reviews", "ops"], "readwrite");
			const done_ = done(tx);
			// the Mac has the changes that were sent; what it did with them is in the deck it just gave
			tx.objectStore("ops").openCursor().onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
				if (!cursor) return;
				if ((cursor.value as OpRow).sent) cursor.delete();
				cursor.continue();
			};
			// answers of cards that left the phone go with them (the Mac has them); answers it does not have yet stay
			const held = new Set(cards.map((c) => c.id));
			tx.objectStore("reviews").openCursor().onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
				if (!cursor) return;
				const row = cursor.value as ReviewRow;
				if (row.sent && !held.has(row.review.cardId)) cursor.delete();
				cursor.continue();
			};
			tx.objectStore("courses").clear();
			tx.objectStore("cards").clear();
			for (const c of courses) tx.objectStore("courses").put(c);
			for (const c of cards) tx.objectStore("cards").put(c);
			for (const review of macReviews) if (held.has(review.cardId)) tx.objectStore("reviews").add({ review, src: "mac", sent: true } satisfies ReviewRow);
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
		async unsentReviews() {
			const tx = db.transaction("reviews", "readonly");
			const rows = (await result(tx.objectStore("reviews").getAll())) as ReviewRow[];
			return rows.filter((r) => !r.sent).map((r) => r.review);
		},
		async markSent(batch) {
			if (batch.length === 0) return;
			const keys = new Set(batch.map(reviewKey));
			const tx = db.transaction("reviews", "readwrite");
			const done_ = done(tx);
			tx.objectStore("reviews").openCursor().onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
				if (!cursor) return;
				const row = cursor.value as ReviewRow;
				if (!row.sent && keys.has(reviewKey(row.review))) cursor.update({ ...row, sent: true } satisfies ReviewRow);
				cursor.continue();
			};
			await done_;
		},
		async importReviews(batch) {
			const rows = (await result(db.transaction("reviews", "readonly").objectStore("reviews").getAll())) as ReviewRow[];
			const fresh = newReviews(rows.map((r) => r.review), batch);
			if (fresh.length === 0) return 0;
			const tx = db.transaction("reviews", "readwrite");
			const done_ = done(tx);
			for (const review of fresh) tx.objectStore("reviews").add({ review, src: "phone", sent: false } satisfies ReviewRow);
			await done_;
			return fresh.length;
		},
		async addCardChange(op, changed) {
			const tx = db.transaction(["cards", "ops"], "readwrite");
			const done_ = done(tx);
			for (const card of changed) tx.objectStore("cards").put(card);
			tx.objectStore("ops").add({ op, sent: false } satisfies OpRow);
			await done_;
		},
		async unsentOps() {
			const rows = (await result(db.transaction("ops", "readonly").objectStore("ops").getAll())) as OpRow[];
			return rows.filter((o) => !o.sent).map((o) => o.op);
		},
		async markOpsSent(batch) {
			if (batch.length === 0) return;
			const keys = new Set(batch.map(opKey));
			const tx = db.transaction("ops", "readwrite");
			const done_ = done(tx);
			tx.objectStore("ops").openCursor().onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
				if (!cursor) return;
				const row = cursor.value as OpRow;
				if (!row.sent && keys.has(opKey(row.op))) cursor.update({ ...row, sent: true } satisfies OpRow);
				cursor.continue();
			};
			await done_;
		},
		async importOps(batch) {
			const rows = (await result(db.transaction("ops", "readonly").objectStore("ops").getAll())) as OpRow[];
			const fresh = newOps(rows.map((o) => o.op), batch);
			if (fresh.length === 0) return 0;
			const tx = db.transaction("ops", "readwrite");
			const done_ = done(tx);
			for (const op of fresh) tx.objectStore("ops").add({ op, sent: false } satisfies OpRow);
			await done_;
			return fresh.length;
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
