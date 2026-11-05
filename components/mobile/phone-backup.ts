/**
 * The backup file on the phone (Learnbox 2.0, Slice 10d): the answers the Mac does not have yet, handed to the share
 * sheet (Files, iCloud Drive, AirDrop, Mail …) or, where there is none, downloaded; and a picked file read back.
 */

import { backupFileName, readPhoneBackup } from "@/src/core";
import type { PhoneBackup } from "@/src/core";

export type BackupOutcome = "shared" | "downloaded" | "cancelled";

/** A backup file is a few lines per answer; anything much bigger is not one of ours. */
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

/** Must run inside the tap that asks for it: the share sheet only opens for a tap. */
export async function saveBackupFile(backup: PhoneBackup, now: Date = new Date()): Promise<BackupOutcome> {
	const name = backupFileName(now);
	const file = new File([JSON.stringify(backup)], name, { type: "application/json" });
	if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
		try {
			await navigator.share({ files: [file], title: name });
			return "shared";
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
			// the share sheet refused (no tap any more, no sharing here): the file is downloaded instead
		}
	}
	const url = URL.createObjectURL(file);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
	return "downloaded";
}

/** A picked file as a backup; null when it is not one of ours. */
export async function readBackupFile(file: Pick<File, "size" | "text">): Promise<{ backup: PhoneBackup; rejected: number } | null> {
	if (file.size > MAX_BACKUP_BYTES) return null;
	try {
		return readPhoneBackup(JSON.parse(await file.text()));
	} catch {
		return null;
	}
}
