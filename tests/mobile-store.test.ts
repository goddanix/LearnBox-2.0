/** Phone access, the files (Slice 10a): config.json and devices.json in a temp dir. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { createMobileStore } from "../src/store/mobile.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-store-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const device = (id: string) => ({ id, name: `Phone ${id}`, tokenHash: "b".repeat(64), createdAt: "2026-11-05T10:00:00.000Z" });

describe("the phone-access store", () => {
	it("reads 'off, no phones' when nothing was ever written", () => {
		const s = createMobileStore(dir);
		assert.deepEqual(s.readConfig(), { v: 1, enabled: false, port: 47831 });
		assert.deepEqual(s.readDevices(), []);
	});

	it("keeps a config and a device list across instances", () => {
		createMobileStore(dir).writeConfig({ v: 1, enabled: true, port: 50001 });
		createMobileStore(dir).writeDevices([device("a"), device("b")]);
		const again = createMobileStore(dir);
		assert.deepEqual(again.readConfig(), { v: 1, enabled: true, port: 50001 });
		assert.deepEqual(again.readDevices().map((d) => d.id), ["a", "b"]);
	});

	it("keeps both files to the owner (0600) and leaves no temp file behind", () => {
		const s = createMobileStore(dir);
		s.writeConfig({ v: 1, enabled: true, port: 47831 });
		s.writeDevices([device("a")]);
		assert.deepEqual(fs.readdirSync(dir).sort(), ["config.json", "devices.json"]);
		for (const f of ["config.json", "devices.json"]) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
	});

	it("reads broken files as the safe default, and skips bad or repeated records", () => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
		fs.writeFileSync(path.join(dir, "devices.json"), JSON.stringify([device("a"), { id: "bad" }, device("a"), "x", device("c")]));
		const s = createMobileStore(dir);
		assert.deepEqual(s.readConfig(), { v: 1, enabled: false, port: 47831 });
		assert.deepEqual(s.readDevices().map((d) => d.id), ["a", "c"]);
		fs.writeFileSync(path.join(dir, "devices.json"), JSON.stringify({ not: "a list" }));
		assert.deepEqual(s.readDevices(), []);
	});

	it("never writes a config it would not read back (a wild port becomes the default)", () => {
		const s = createMobileStore(dir);
		s.writeConfig({ v: 1, enabled: true, port: 80 });
		assert.deepEqual(s.readConfig(), { v: 1, enabled: true, port: 47831 });
	});
});
