/**
 * MobileStore — the fs adapter for phone access, at config.PATHS.mobile:
 *   config.json   { v, enabled, port }
 *   devices.json  [{ id, name, tokenHash, createdAt, lastSeenAt?, revokedAt? }]
 *
 * Both files are small and replaced whole, atomically (write a sibling, rename over): a crash never leaves half a
 * file. devices.json is owner-only (0600) — it holds the hashes of the phones' keys. A file that is missing or
 * unreadable reads as the default (access off, no phones): the safe direction. Implements core/ports.ts MobileStore;
 * `createMobileStore(dir)` takes the folder so tests run in a temp dir.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { DEFAULT_MOBILE_CONFIG, cleanDevice, cleanMobileConfig } from "../core/mobile.ts";
import type { MobileConfig, MobileDevice } from "../core/contracts.ts";
import type { MobileStore } from "../core/ports.ts";

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return undefined;
	}
}

function writeAtomic(file: string, value: unknown, mode: number): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, { encoding: "utf-8", mode });
	fs.renameSync(tmp, file);
}

export function createMobileStore(dir: string): MobileStore {
	const configFile = path.join(dir, "config.json");
	const devicesFile = path.join(dir, "devices.json");
	return {
		readConfig(): MobileConfig {
			const raw = readJson(configFile);
			return raw === undefined ? { ...DEFAULT_MOBILE_CONFIG } : cleanMobileConfig(raw);
		},
		writeConfig(config) {
			writeAtomic(configFile, cleanMobileConfig(config), 0o600);
		},
		readDevices(): MobileDevice[] {
			const raw = readJson(devicesFile);
			if (!Array.isArray(raw)) return [];
			const seen = new Set<string>();
			const out: MobileDevice[] = [];
			for (const item of raw) {
				const device = cleanDevice(item);
				if (device && !seen.has(device.id)) {
					seen.add(device.id);
					out.push(device);
				}
			}
			return out;
		},
		writeDevices(devices) {
			writeAtomic(devicesFile, devices, 0o600);
		},
	};
}

export const mobileStore: MobileStore = createMobileStore(PATHS.mobile);
