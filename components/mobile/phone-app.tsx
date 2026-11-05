"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PhoneLesson, StudyCourseSummary, StudyLinkCard } from "@/src/core";
import { buildPhoneBackup, cardChangesText } from "@/src/core";
import { keepAppForOffline } from "./offline-shell";
import { getPhoneToken, phoneFetch } from "./phone-auth";
import { readBackupFile, saveBackupFile } from "./phone-backup";
import { PhoneCourses, PhoneSetup } from "./phone-courses";
import { PhoneApiError } from "./phone-http";
import { PhoneLesson as PhoneLessonPage } from "./phone-lesson";
import { PhoneLessonStart } from "./phone-lesson-start";
import { listPhoneLessons, startPhoneLesson } from "./phone-lessons";
import { formatPhoneHash, parsePhoneHash } from "./phone-route";
import type { PhoneRoute } from "./phone-route";
import { PhoneSession } from "./phone-session";
import { openPhoneSource } from "./phone-source";
import type { PhoneSource, UpdateResult } from "./phone-source";
import type { PullProgress } from "./pull-deck";
import { useOnline } from "./use-online";

const readRoute = (): PhoneRoute => {
	try {
		return parsePhoneHash(window.location.hash);
	} catch {
		return { kind: "courses" };
	}
};
/** Show a screen: a back swipe on the phone leaves it, a reload keeps it. `replace` swaps the current address instead of adding one. */
const writeRoute = (route: PhoneRoute, replace = false) => {
	try {
		const next = formatPhoneHash(route);
		if (window.location.hash === next) return;
		const url = `${window.location.pathname}${next}`;
		if (replace) window.history.replaceState(null, "", url);
		else window.history.pushState(null, "", url);
	} catch {
		/* no address bar to keep in step with */
	}
};

/** One screen back: the browser's own back when there is one to go to, else the course list. */
const goBack = (fallback: () => void) => {
	try {
		if (window.history.length > 1) {
			window.history.back();
			return;
		}
	} catch {
		/* no history to walk */
	}
	fallback();
};

/** What an update did, in a sentence. */
export function updateSummary(r: UpdateResult): string {
	const parts = [`${r.cards} card${r.cards === 1 ? "" : "s"}`];
	if (r.sent > 0) parts.push(`${r.sent} answer${r.sent === 1 ? "" : "s"} sent to the Mac`);
	if (r.sentOps > 0) parts.push(`${cardChangesText(r.sentOps)} sent to the Mac`);
	if (r.newerOnMac > 0) parts.push(`${cardChangesText(r.newerOnMac)} not kept: the card was changed on the Mac since`);
	if (r.reviews > 0) parts.push(`${r.reviews} new answer${r.reviews === 1 ? "" : "s"} from the Mac`);
	if (r.media > 0) parts.push(`${r.media} picture${r.media === 1 ? "" : "s"}`);
	const failed = r.mediaFailed > 0 ? ` ${r.mediaFailed} picture${r.mediaFailed === 1 ? "" : "s"} did not come; update again to retry.` : "";
	return `Updated: ${parts.join(", ")}.${failed}`;
}

/**
 * The phone app: the course list and one course's review, over the phone's own copy of the cards — it works without
 * a connection. The Mac is only asked when the learner updates. `open` is where the cards come from (tests give it a
 * fake; the real one is the phone's storage).
 */
export function PhoneApp({ open = openPhoneSource }: { open?: () => Promise<PhoneSource> } = {}) {
	const router = useRouter();
	const [ready, setReady] = useState(false);
	const [source, setSource] = useState<PhoneSource | null>(null);
	const [fatal, setFatal] = useState<string | null>(null);
	const [courses, setCourses] = useState<StudyCourseSummary[] | null>(null);
	const [route, setRoute] = useState<PhoneRoute>({ kind: "courses" });
	const [deviceName, setDeviceName] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [updating, setUpdating] = useState<PullProgress | null>(null);
	const [updated, setUpdated] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const online = useOnline();
	/** Each course's weak spots (the phone's own answers) and lessons (asked of the Mac while online). */
	const [weak, setWeak] = useState<Record<string, StudyLinkCard[]>>({});
	const [lessons, setLessons] = useState<Record<string, PhoneLesson[]>>({});
	/** The lesson being started: the cards' faces for the draft, and whether the Mac is being asked. */
	const [faces, setFaces] = useState<StudyLinkCard[] | null>(null);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	/** The first message of the lesson just started: the lesson page sends it once, as turn 1. */
	const [first, setFirst] = useState<{ chatId: string; text: string } | null>(null);
	const sourceRef = useRef<PhoneSource | null>(null);
	sourceRef.current = source;

	// Not paired (no key, or it was locked): the pairing page is the only place to go.
	const onApiError = useCallback(
		(e: unknown) => {
			if (e instanceof PhoneApiError && e.kind === "unpaired") router.replace("/m/pair");
		},
		[router],
	);

	const loadCourses = useCallback(async () => {
		const engine = sourceRef.current?.engine;
		if (!engine) return;
		try {
			const list = await engine.api.courses();
			setCourses(list);
			setError(null);
			// from the phone's own answers: a missing list only hides it
			const entries = await Promise.all(list.map(async (c) => [c.id, await engine.api.weakSpots(c.id).catch(() => [] as StudyLinkCard[])] as const));
			setWeak(Object.fromEntries(entries));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		if (!getPhoneToken()) {
			router.replace("/m/pair");
			return;
		}
		setRoute(readRoute());
		setReady(true);
		let live = true;
		open().then(
			(s) => {
				if (!live) return;
				sourceRef.current = s;
				setSource(s);
				void loadCourses();
			},
			(e: unknown) => live && setFatal(e instanceof Error ? e.message : "This browser cannot keep cards on the phone."),
		);
		// which phone this is, when the Mac can be asked; offline there is nothing to show
		void phoneFetch("/m-api/me")
			.then(async (res) => {
				if (res.ok && live) setDeviceName(((await res.json()) as { device: { name: string } }).device.name);
			})
			.catch(() => {});
		const onHash = () => setRoute(readRoute());
		// coming back to the app (the phone was locked, another app was in front): the day may have turned
		const onVisible = () => {
			if (document.visibilityState === "visible" && readRoute().kind === "courses") void loadCourses();
		};
		window.addEventListener("hashchange", onHash);
		window.addEventListener("popstate", onHash);
		document.addEventListener("visibilitychange", onVisible);
		// the app's own files are kept for offline starts (production builds only: a dev server's files change on every edit)
		if (process.env.NODE_ENV === "production") void keepAppForOffline();
		return () => {
			live = false;
			window.removeEventListener("hashchange", onHash);
			window.removeEventListener("popstate", onHash);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [router, open, loadCourses]);

	/** Show a screen (and remember it in the address). */
	const navigate = useCallback((next: PhoneRoute, replace = false) => {
		writeRoute(next, replace);
		setRoute(next);
	}, []);

	// the course list's lessons live on the Mac: asked while that screen is up and the phone is online; a failed ask only hides them
	useEffect(() => {
		if (!courses || route.kind !== "courses" || !online) return;
		let live = true;
		void Promise.all(
			courses.map(
				async (c) =>
					[
						c.id,
						await listPhoneLessons(c.id).catch((e: unknown) => {
							onApiError(e);
							return [] as PhoneLesson[];
						}),
					] as const,
			),
		).then((entries) => live && setLessons(Object.fromEntries(entries)));
		return () => {
			live = false;
		};
	}, [courses, route.kind, online, onApiError]);

	// the faces of the cards a lesson is about to start from, from the phone's own copy
	useEffect(() => {
		if (route.kind !== "learn") {
			setFaces(null);
			setStartError(null);
			return;
		}
		let live = true;
		void source?.engine?.api.linkCards(route.courseId, route.cardIds).then(
			(f) => live && setFaces(f),
			() => {},
		);
		return () => {
			live = false;
		};
	}, [route, source]);

	/** Create the lesson on the Mac; its page then sends the first message as turn 1. */
	const startLesson = async (text: string) => {
		if (route.kind !== "learn" || starting) return;
		setStarting(true);
		setStartError(null);
		try {
			const chatId = await startPhoneLesson({ courseId: route.courseId, cardIds: route.cardIds, text });
			setFirst({ chatId, text });
			navigate({ kind: "lesson", chatId }, true);
		} catch (e) {
			setStartError(e instanceof Error ? e.message : String(e));
			onApiError(e);
		} finally {
			setStarting(false);
		}
	};

	const update = useCallback(async () => {
		const current = sourceRef.current;
		if (!current || updating) return;
		setError(null);
		setUpdated(null);
		setNotice(null);
		setUpdating({ phase: "deck", done: 0, total: 1 });
		try {
			const { result, source: next } = await current.update(setUpdating);
			sourceRef.current = next;
			setSource(next);
			setUpdated(updateSummary(result));
			await loadCourses();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			onApiError(e);
		} finally {
			setUpdating(null);
		}
	}, [updating, loadCourses, onApiError]);

	/** The answers only this phone has, handed to the share sheet. Runs inside the tap: nothing is awaited before the share. */
	const saveBackup = () => {
		const engine = sourceRef.current?.engine;
		if (!engine) return;
		setNotice(null);
		const backup = buildPhoneBackup(engine.unsentReviews(), new Date(), deviceName ?? undefined, engine.unsentOps());
		void saveBackupFile(backup).then(
			(how) => setNotice(how === "shared" ? "Backup handed over." : how === "downloaded" ? "Backup file downloaded." : null),
			(e: unknown) => setNotice(`Could not save the backup: ${e instanceof Error ? e.message : String(e)}`),
		);
	};

	/** A backup file picked on this phone: its answers join the ones waiting to be sent. */
	const restoreBackup = async (file: File) => {
		const current = sourceRef.current;
		if (!current) return;
		setNotice(null);
		const read = await readBackupFile(file);
		if (!read) {
			setNotice("This is not a Learnbox phone backup file.");
			return;
		}
		try {
			const { added, addedOps, source: next } = await current.restore(read.backup);
			sourceRef.current = next;
			setSource(next);
			const total = read.backup.reviews.length;
			const totalOps = read.backup.ops?.length ?? 0;
			const known = total - added + (totalOps - addedOps);
			const parts = [`${added} new answer${added === 1 ? "" : "s"}`];
			if (totalOps > 0) parts.push(`${cardChangesText(addedOps)} to send`);
			if (known > 0) parts.push(`${known} already here`);
			if (read.rejected > 0) parts.push(`${read.rejected} unreadable skipped`);
			setNotice(`Backup read: ${parts.join(", ")}.`);
			await loadCourses();
		} catch (e) {
			setNotice(`Could not read the backup: ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	if (!ready) return null;
	if (fatal) return <p className="px-4 py-10 text-sm text-red-400" role="alert" data-testid="phone-error">{fatal}</p>;
	if (!source) return <p className="px-4 py-10 text-sm text-muted-foreground">Loading…</p>;
	const engine = source.engine;
	if (!engine) return <PhoneSetup updating={updating} error={error} onStart={() => void update()} />;

	const routeCourseId = route.kind === "course" || route.kind === "learn" ? route.courseId : null;
	if (routeCourseId && !courses && !error) return <p className="px-4 py-10 text-sm text-muted-foreground">Loading…</p>;
	if (route.kind === "lesson") {
		return (
			<PhoneLessonPage
				chatId={route.chatId}
				firstMessage={first?.chatId === route.chatId ? first.text : undefined}
				onError={onApiError}
				onExit={() => {
					navigate({ kind: "courses" });
					void loadCourses();
				}}
			/>
		);
	}
	const course = routeCourseId ? courses?.find((c) => c.id === routeCourseId) : undefined;
	if (route.kind === "learn" && course) {
		return (
			<PhoneLessonStart
				courseName={course.name}
				count={route.cardIds.length}
				faces={faces}
				online={online}
				busy={starting}
				error={startError}
				onStart={(text) => void startLesson(text)}
				onBack={() => goBack(() => navigate({ kind: "courses" }))}
			/>
		);
	}
	if (route.kind === "course" && course) {
		return (
			<PhoneSession
				api={engine.api}
				course={course}
				onError={onApiError}
				unsent={engine.unsent}
				unsentOps={() => engine.unsentOps().length}
				onBackup={saveBackup}
				notice={notice}
				online={online}
				onLearn={(cardId) => navigate({ kind: "learn", courseId: course.id, cardIds: [cardId] })}
				onExit={() => {
					setNotice(null);
					navigate({ kind: "courses" });
					void loadCourses();
				}}
			/>
		);
	}
	return (
		<PhoneCourses
			courses={courses}
			error={error}
			deviceName={deviceName}
			syncedAt={engine.meta.syncedAt}
			unsent={engine.unsent()}
			unsentOps={engine.unsentOps().length}
			updating={updating}
			updated={updated}
			notice={notice}
			weak={weak}
			lessons={online ? lessons : {}}
			online={online}
			onBackup={saveBackup}
			onRestore={(file) => void restoreBackup(file)}
			onPick={(c) => navigate({ kind: "course", courseId: c.id })}
			onLearn={(courseId, cardIds) => navigate({ kind: "learn", courseId, cardIds })}
			onOpenLesson={(chatId) => navigate({ kind: "lesson", chatId })}
			onUpdate={() => void update()}
		/>
	);
}
