/**
 * The backup file on the phone (Learnbox 2.0, Slice 10d): handed to the share sheet when there is one, downloaded
 * when there is not, left alone when the learner cancels; and a picked file read back — or refused.
 */
import { dom } from "./helpers/linkedom-page.ts";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { readBackupFile, saveBackupFile } from "../components/mobile/phone-backup.ts";
import { buildPhoneBackup } from "../src/core/phone-sync.ts";
import type { StudyReview } from "../src/core/index.ts";

void dom;

const NOW = new Date(2026, 10, 5, 21, 7); // local time, as the file name is
const REVIEW: StudyReview = { cardId: "c1", at: "2026-11-05T20:00:00.000Z", grade: 3, ms: 900 };
const BACKUP = buildPhoneBackup([REVIEW], NOW, "iPhone");

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const realTimeout = globalThis.setTimeout;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
afterEach(() => {
	if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
	globalThis.setTimeout = realTimeout;
	URL.createObjectURL = realCreate;
	URL.revokeObjectURL = realRevoke;
	document.body.innerHTML = "";
});

const setNavigator = (nav: Record<string, unknown>) => Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });

/** The anchor clicks the page makes: the file name and what was in the blob. */
function watchDownloads() {
	const downloads: { name: string; href: string }[] = [];
	const revoked: string[] = [];
	URL.createObjectURL = () => "blob:fake-1";
	URL.revokeObjectURL = (u) => void revoked.push(u);
	const timers: (() => void)[] = [];
	globalThis.setTimeout = ((fn: () => void) => void timers.push(fn)) as unknown as typeof setTimeout;
	const create = document.createElement.bind(document);
	document.createElement = ((tag: string) => {
		const el = create(tag);
		if (tag === "a") el.click = () => void downloads.push({ name: el.getAttribute("download") ?? "", href: el.getAttribute("href") ?? "" });
		return el;
	}) as typeof document.createElement;
	return { downloads, revoked, timers };
}

describe("saving the backup file", () => {
	it("hands the file to the share sheet when the phone can share files", async () => {
		const shared: { files: File[]; title: string }[] = [];
		setNavigator({ canShare: () => true, share: async (d: { files: File[]; title: string }) => void shared.push(d) });
		assert.equal(await saveBackupFile(BACKUP, NOW), "shared");
		assert.equal(shared.length, 1);
		assert.equal(shared[0]!.files[0]!.name, "learnbox-backup-2026-11-05-2107.json");
		assert.equal(shared[0]!.files[0]!.type, "application/json");
		assert.deepEqual(JSON.parse(await shared[0]!.files[0]!.text()), BACKUP);
	});

	it("leaves everything alone when the learner closes the share sheet", async () => {
		const watch = watchDownloads();
		setNavigator({ canShare: () => true, share: async () => { throw new DOMException("closed", "AbortError"); } });
		assert.equal(await saveBackupFile(BACKUP, NOW), "cancelled");
		assert.deepEqual(watch.downloads, []);
	});

	it("downloads the file when the share sheet refuses", async () => {
		const watch = watchDownloads();
		setNavigator({ canShare: () => true, share: async () => { throw new DOMException("no tap", "NotAllowedError"); } });
		assert.equal(await saveBackupFile(BACKUP, NOW), "downloaded");
		assert.deepEqual(watch.downloads, [{ name: "learnbox-backup-2026-11-05-2107.json", href: "blob:fake-1" }]);
	});

	it("downloads the file where there is no sharing at all, and lets go of the address later", async () => {
		const watch = watchDownloads();
		setNavigator({});
		assert.equal(await saveBackupFile(BACKUP, NOW), "downloaded");
		assert.equal(watch.downloads.length, 1);
		assert.equal(document.querySelector("a"), null, "the anchor does not stay on the page");
		assert.deepEqual(watch.revoked, []);
		watch.timers[0]!();
		assert.deepEqual(watch.revoked, ["blob:fake-1"]);
	});

	it("downloads the file when this browser cannot share files", async () => {
		const watch = watchDownloads();
		setNavigator({ canShare: () => false, share: async () => { throw new Error("must not be called"); } });
		assert.equal(await saveBackupFile(BACKUP, NOW), "downloaded");
		assert.equal(watch.downloads.length, 1);
	});
});

describe("reading a backup file", () => {
	const file = (text: string, size = text.length) => ({ size, text: async () => text });

	it("gives back the backup and how many lines were unreadable", async () => {
		const out = await readBackupFile(file(JSON.stringify({ ...BACKUP, reviews: [...BACKUP.reviews, { nonsense: true }] })));
		assert.deepEqual(out?.backup.reviews, BACKUP.reviews);
		assert.equal(out?.rejected, 1);
	});

	it("refuses what is not a backup: other JSON, text that is not JSON, a file that is far too big", async () => {
		assert.equal(await readBackupFile(file("[]")), null);
		assert.equal(await readBackupFile(file(JSON.stringify({ kind: "something-else", reviews: [] }))), null);
		assert.equal(await readBackupFile(file("not json {")), null);
		assert.equal(await readBackupFile(file(JSON.stringify(BACKUP), 21 * 1024 * 1024)), null);
	});

	it("refuses a file that cannot be read", async () => {
		assert.equal(await readBackupFile({ size: 10, text: async () => { throw new Error("gone"); } }), null);
	});
});
