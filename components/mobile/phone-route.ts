/**
 * Where the phone app is, kept in the address (`#/…`) so a back swipe leaves a screen and a reload keeps it. Pure:
 * phone-app.tsx reads and writes the address; tests drive these.
 *
 *   (none)                      the course list
 *   #/c/<course>                one course's review
 *   #/learn/<course>[/<card>…]  the start of a lesson on the Mac, from cards (or about the course)
 *   #/lesson/<chat>             one lesson
 *   #/library                   which courses this phone holds
 */

export type PhoneRoute =
	| { kind: "courses" }
	| { kind: "course"; courseId: string }
	| { kind: "learn"; courseId: string; cardIds: string[] }
	| { kind: "lesson"; chatId: string }
	| { kind: "library" };

const decode = (s: string): string | null => {
	try {
		return decodeURIComponent(s);
	} catch {
		return null;
	}
};

export function parsePhoneHash(hash: string): PhoneRoute {
	const parts = /^#\/(.+)$/.exec(hash)?.[1]?.split("/") ?? [];
	if (parts.length === 1 && parts[0] === "library") return { kind: "library" };
	const ids = parts.slice(1).map(decode);
	if (ids.length === 0 || ids.some((id) => id === null || id === "")) return { kind: "courses" };
	const [first, ...rest] = ids as string[];
	if (parts[0] === "c" && rest.length === 0) return { kind: "course", courseId: first! };
	if (parts[0] === "learn") return { kind: "learn", courseId: first!, cardIds: rest };
	if (parts[0] === "lesson" && rest.length === 0) return { kind: "lesson", chatId: first! };
	return { kind: "courses" };
}

export function formatPhoneHash(route: PhoneRoute): string {
	const enc = encodeURIComponent;
	switch (route.kind) {
		case "courses":
			return "";
		case "course":
			return `#/c/${enc(route.courseId)}`;
		case "learn":
			return `#/learn/${[route.courseId, ...route.cardIds].map(enc).join("/")}`;
		case "lesson":
			return `#/lesson/${enc(route.chatId)}`;
		case "library":
			return "#/library";
	}
}
