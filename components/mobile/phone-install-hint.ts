/**
 * The nudge to put the app on the home screen (Learnbox 2.0, Slice 10g). The icon is made from the page the learner is
 * on, so it has to be made from the course list, not from the pairing page; and an installed app has storage of its
 * own, separate from Safari's. The hint is for Safari only (an installed app has no use for it) and goes away for good
 * once dismissed.
 */

const DISMISSED = "lh-phone-install-hint";

/** Running as an installed web app (iOS: `navigator.standalone`; elsewhere the display-mode media query). */
export function isStandalone(): boolean {
	try {
		if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
		return typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
	} catch {
		return false;
	}
}

export function installHintDismissed(): boolean {
	try {
		return localStorage.getItem(DISMISSED) === "1";
	} catch {
		return false;
	}
}

export function dismissInstallHint(): void {
	try {
		localStorage.setItem(DISMISSED, "1");
	} catch {
		/* shown again next time */
	}
}
