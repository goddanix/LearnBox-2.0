"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { StudyCourseSummary } from "@/src/core";
import { getPhoneToken, phoneFetch } from "./phone-auth";
import { PhoneCourses } from "./phone-courses";
import { PhoneSession } from "./phone-session";
import { httpStudyApi, PhoneApiError } from "./study-api";
import type { PhoneStudyApi } from "./study-api";

/** The course in the address (`#/c/<id>`): a back swipe on the phone leaves the session, a reload keeps it. */
const readHash = (): string | null => {
	try {
		const m = /^#\/c\/(.+)$/.exec(window.location.hash);
		return m ? decodeURIComponent(m[1]!) : null;
	} catch {
		return null;
	}
};
const writeHash = (courseId: string | null) => {
	try {
		const next = courseId ? `#/c/${encodeURIComponent(courseId)}` : "";
		if (window.location.hash !== next) window.history.pushState(null, "", `${window.location.pathname}${next}`);
	} catch {
		/* no address bar to keep in step with */
	}
};

/**
 * The phone app: the course list and one course's review. It talks to the study engine only through `api`, so
 * the same screens run against the Mac (10b) and against the phone's own copy (10c).
 */
export function PhoneApp({ api: given }: { api?: PhoneStudyApi } = {}) {
	const router = useRouter();
	const api = useMemo(() => given ?? httpStudyApi(), [given]);
	const [ready, setReady] = useState(false);
	const [courses, setCourses] = useState<StudyCourseSummary[] | null>(null);
	const [courseId, setCourseId] = useState<string | null>(null);
	const [deviceName, setDeviceName] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Not paired (no key, or it was locked): the pairing page is the only place to go.
	const onApiError = useCallback(
		(e: unknown) => {
			if (e instanceof PhoneApiError && e.kind === "unpaired") router.replace("/m/pair");
		},
		[router],
	);

	const loadCourses = useCallback(async () => {
		try {
			setCourses(await api.courses());
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			onApiError(e);
		}
	}, [api, onApiError]);

	useEffect(() => {
		if (!getPhoneToken()) {
			router.replace("/m/pair");
			return;
		}
		setCourseId(readHash());
		setReady(true);
		void loadCourses();
		void phoneFetch("/m-api/me")
			.then(async (res) => {
				if (res.ok) setDeviceName(((await res.json()) as { device: { name: string } }).device.name);
			})
			.catch(() => {
				/* the Mac is not reachable: nothing to show here */
			});
		const onHash = () => setCourseId(readHash());
		// coming back to the app (the phone was locked, another app was in front): the counts moved on
		const onVisible = () => {
			if (document.visibilityState === "visible" && !readHash()) void loadCourses();
		};
		window.addEventListener("hashchange", onHash);
		window.addEventListener("popstate", onHash);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			window.removeEventListener("hashchange", onHash);
			window.removeEventListener("popstate", onHash);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [router, loadCourses]);

	if (!ready) return null;

	const course = courseId ? courses?.find((c) => c.id === courseId) : undefined;
	if (courseId && !courses && !error) return <p className="px-4 py-10 text-sm text-muted-foreground">Loading…</p>;
	if (course) {
		return (
			<PhoneSession
				api={api}
				course={course}
				onError={onApiError}
				onExit={() => {
					setCourseId(null);
					writeHash(null);
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
			onPick={(c) => {
				setCourseId(c.id);
				writeHash(c.id);
			}}
			onRefresh={() => void loadCourses()}
		/>
	);
}
