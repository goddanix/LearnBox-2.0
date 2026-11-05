"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mcqCorrect, mcqSuggestedGrade } from "@/src/core";
import type { StudyGrade, StudyNextResult } from "@/src/core";
import type { PhoneStudyApi } from "./study-api";

/** What undo takes back: the latest review of this session, and the step the card was shown at. */
interface UndoEntry {
	cardId: string;
	step: number;
}

/**
 * One course's review session on the phone. The engine is stateless (it re-derives the queue on every call), so the
 * session carries only `step` (the new/new/again pattern's position, inside `state`) and the card on screen.
 */
export function useStudySession(api: PhoneStudyApi, courseId: string, onError?: (e: unknown) => void) {
	const [state, setState] = useState<StudyNextResult | null>(null);
	const [revealed, setRevealed] = useState(false);
	const [picked, setPicked] = useState<string[]>([]);
	const [shown, setShown] = useState(0);
	const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const shownAt = useRef(0);
	const answered = useRef(0);
	const failed = useRef(onError);
	failed.current = onError;

	const show = useCallback((next: StudyNextResult) => {
		setState(next);
		setRevealed(false);
		setPicked([]);
		setShown((n) => n + 1);
		shownAt.current = Date.now();
	}, []);

	const fail = useCallback((e: unknown) => {
		setError(e instanceof Error ? e.message : String(e));
		failed.current?.(e);
	}, []);

	const load = useCallback(() => {
		setError(null);
		return api.next(courseId, 0).then(show, fail);
	}, [api, courseId, show, fail]);

	useEffect(() => {
		let cancelled = false;
		api.next(courseId, 0).then(
			(r) => {
				if (!cancelled) show(r);
			},
			(e: unknown) => {
				if (!cancelled) fail(e);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [api, courseId, show, fail]);

	const run = useCallback(
		async (call: () => Promise<StudyNextResult>, then: (next: StudyNextResult) => void) => {
			setBusy(true);
			try {
				then(await call());
				setError(null);
			} catch (e) {
				fail(e);
			} finally {
				setBusy(false);
			}
		},
		[fail],
	);

	const card = state?.card ?? null;
	/** An MCQ's suggested grade from what was picked (right options → Good, wrong → Again). */
	const suggested: StudyGrade | null = useMemo(() => (card?.kind === "mcq" ? mcqSuggestedGrade(mcqCorrect(card.fields), picked) : null), [card, picked]);

	const reveal = useCallback(() => setRevealed(true), []);

	const answer = useCallback(
		(grade: StudyGrade) => {
			if (!state?.card || busy) return;
			const entry: UndoEntry = { cardId: state.card.id, step: state.step };
			void run(
				() => api.answer({ courseId, cardId: entry.cardId, grade, ms: Date.now() - shownAt.current, step: entry.step }),
				(next) => {
					answered.current += 1;
					setUndoStack((s) => [...s, entry]);
					show(next);
				},
			);
		},
		[state, busy, api, courseId, run, show],
	);

	const undo = useCallback(() => {
		const entry = undoStack.at(-1);
		if (!entry || busy) return;
		setUndoStack((s) => s.slice(0, -1));
		void run(
			() => api.undo({ courseId, cardId: entry.cardId, step: entry.step }),
			(next) => {
				answered.current = Math.max(0, answered.current - 1);
				show(next);
			},
		);
	}, [undoStack, busy, api, courseId, run, show]);

	return { state, card, revealed, reveal, picked, setPicked, shown, suggested, busy, error, canUndo: undoStack.length > 0, answered: answered.current, answer, undo, reload: load };
}
