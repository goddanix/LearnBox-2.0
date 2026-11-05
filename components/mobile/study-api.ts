/**
 * What the phone's review screens ask of the study engine (Learnbox 2.0, Slice 10). One seam, two implementations:
 * the Mac over the gateway (here, Slice 10b) and the phone's own copy of the cards and the scheduler (10c). The
 * screens never know which one answers.
 */

import type { StudyCourseSummary, StudyGrade, StudyNextResult } from "@/src/core";
import { phoneFetch } from "./phone-auth";

export interface PhoneStudyApi {
	courses(): Promise<StudyCourseSummary[]>;
	/** The next card of a course (`step` 0 starts a session); `openCardId` shows that card first. */
	next(courseId: string, step: number, openCardId?: string): Promise<StudyNextResult>;
	answer(input: { courseId: string; cardId: string; grade: StudyGrade; ms: number; step: number }): Promise<StudyNextResult>;
	undo(input: { courseId: string; cardId: string; step: number }): Promise<StudyNextResult>;
}

/** unpaired: this phone's key is gone or locked · unreachable: no answer from the Mac · server: the Mac said no. */
export type PhoneApiErrorKind = "unpaired" | "unreachable" | "server";

export class PhoneApiError extends Error {
	constructor(
		message: string,
		readonly kind: PhoneApiErrorKind,
	) {
		super(message);
		this.name = "PhoneApiError";
	}
}

const jsonInit = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function call<T>(url: string, init?: RequestInit): Promise<T> {
	let res: Response;
	try {
		res = await phoneFetch(url, init);
	} catch {
		throw new PhoneApiError("Cannot reach your Mac.", "unreachable");
	}
	if (res.status === 401) throw new PhoneApiError("This phone is not paired (any more).", "unpaired");
	// the Mac's own server being down is the gateway's 502
	if (res.status === 502) throw new PhoneApiError("Learnbox is not answering on your Mac.", "unreachable");
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new PhoneApiError(body?.error ?? `Request failed (${res.status})`, "server");
	}
	return (await res.json()) as T;
}

/** The online engine: the Mac's study routes, through the gateway. */
export function httpStudyApi(): PhoneStudyApi {
	return {
		courses: async () => (await call<{ courses: StudyCourseSummary[] }>("/api/study/courses")).courses,
		next: (courseId, step, openCardId) =>
			call<StudyNextResult>(`/api/study/next?course=${encodeURIComponent(courseId)}&step=${step}${openCardId ? `&card=${encodeURIComponent(openCardId)}` : ""}`),
		answer: (input) => call<StudyNextResult>("/api/study/answer", jsonInit(input)),
		undo: (input) => call<StudyNextResult>("/api/study/undo", jsonInit(input)),
	};
}
