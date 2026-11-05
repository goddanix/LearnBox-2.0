"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeftIcon, SendIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { AnsweredCard } from "@/components/answered-card";
import { QuestionDock } from "@/components/question-dock";
import { useChatSession } from "@/components/session";
import { StudyContextCard } from "@/components/study-context-card";
import { findPendingToolCall, phaseTimeline } from "@/src/core";
import type { LhMessage, LhViewMessage, QuestionAnswerData, StudyContextData } from "@/src/core";
import { NEEDS_MAC } from "./phone-course-extras";
import { phoneJson } from "./phone-http";
import { describeLessonError, lessonFetch } from "./phone-lessons";
import { useOnline } from "./use-online";

/** The Mac's chat record, as far as the phone reads it. */
interface LessonRecord {
	id: string;
	title: string;
	messages: LhMessage[];
	turnInFlight: boolean;
	turnError?: string;
}

/** The tools whose answered calls render as a graded card (the questions the dock asks). */
const QUESTION_TOOLS = ["tool-quiz", "tool-probe", "tool-ask_user_question", "tool-explain", "tool-recall"];

/** The first message is owed when the lesson has no conversation yet (a context marker alone does not count) — the Mac's rule. */
export function firstMessageOwed(messages: readonly { role: string }[], first: string | undefined): boolean {
	return !!first && !messages.some((m) => m.role === "user" || m.role === "assistant");
}

/**
 * One lesson on the phone: the conversation with Claude on the Mac, read from the Mac's record and followed live. It
 * is the same session machinery the Mac runs (components/session-core.ts) with the phone's key and the gateway's lesson
 * addresses; the transcript shows the teacher's text, the learner's words and the graded questions, and a question
 * that waits for an answer opens in the same dock as on the Mac. Plan, graph, attachments and model choice stay on the Mac.
 */
export function PhoneLesson({ chatId, firstMessage, onExit, onError }: { chatId: string; firstMessage?: string; onExit: () => void; onError?: (e: unknown) => void }) {
	const [record, setRecord] = useState<LessonRecord | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let live = true;
		setError(null);
		phoneJson<LessonRecord>(`/api/phone/lesson/${encodeURIComponent(chatId)}`).then(
			(r) => live && setRecord(r),
			(e: unknown) => {
				if (!live) return;
				setError(e instanceof Error ? e.message : String(e));
				onError?.(e);
			},
		);
		return () => {
			live = false;
		};
	}, [chatId, attempt, onError]);

	if (!record) {
		return (
			<div className="flex min-h-dvh flex-col" data-testid="phone-lesson">
				<LessonHeader title="" onExit={onExit} />
				{error ? (
					<div className="mx-3 flex items-center gap-2 rounded-md border border-red-500/40 p-2 text-sm text-red-400" role="alert" data-testid="phone-lesson-error">
						<span className="min-w-0 flex-1">{error}</span>
						<button type="button" onClick={() => setAttempt((n) => n + 1)} className="h-9 shrink-0 rounded-md border px-3 text-foreground active:bg-accent" data-testid="phone-lesson-retry">
							Retry
						</button>
					</div>
				) : (
					<p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
				)}
			</div>
		);
	}
	return <LessonSession key={chatId} chatId={chatId} record={record} firstMessage={firstMessage} onExit={onExit} />;
}

function LessonHeader({ title, onExit }: { title: string; onExit: () => void }) {
	return (
		<header className="flex items-center gap-1 px-2 py-1">
			<button type="button" onClick={onExit} aria-label="Back to courses" className="flex size-11 items-center justify-center rounded-full text-muted-foreground active:bg-accent" data-testid="phone-lesson-exit">
				<ArrowLeftIcon className="size-5" />
			</button>
			<span className="min-w-0 flex-1 truncate text-center text-sm text-muted-foreground" data-testid="phone-lesson-title">
				{title}
			</span>
			<span className="size-11" aria-hidden="true" />
		</header>
	);
}

function LessonSession({ chatId, record, firstMessage, onExit }: { chatId: string; record: LessonRecord; firstMessage?: string; onExit: () => void }) {
	const wire = useMemo(() => lessonFetch(chatId), [chatId]);
	const online = useOnline();
	const s = useChatSession({ chatId, initialMessages: record.messages, initialError: record.turnError, initiallyInFlight: record.turnInFlight, fetch: wire });
	const [text, setText] = useState("");
	const busy = s.status === "submitted" || s.status === "streaming";
	const pending = findPendingToolCall(s.messages);
	const phases = useMemo(() => phaseTimeline(s.messages), [s.messages]);

	// the first message goes out once, when the lesson has nothing said yet
	const sent = useRef(false);
	useEffect(() => {
		if (sent.current || !firstMessageOwed(record.messages, firstMessage)) return;
		sent.current = true;
		s.send({ type: "text", text: firstMessage! });
		// once per mount: the record and the message are what the page opened with
	}, []);

	// follow the conversation while the reader is at its end; a reader who scrolled up is left alone
	const scroller = useRef<HTMLDivElement>(null);
	const atEnd = useRef(true);
	useEffect(() => {
		const el = scroller.current;
		if (el && atEnd.current) el.scrollTop = el.scrollHeight;
	}, [s.messages, pending?.toolCallId, busy]);

	const canSend = !busy && !pending && text.trim().length > 0;
	const send = () => {
		if (!canSend) return;
		s.send({ type: "text", text: text.trim() });
		setText("");
		atEnd.current = true;
	};

	return (
		<div className="flex h-dvh flex-col" data-testid="phone-lesson">
			<LessonHeader title={record.title} onExit={onExit} />
			<div
				ref={scroller}
				onScroll={(e) => {
					const el = e.currentTarget;
					atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
				className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4 pt-2"
				data-testid="phone-lesson-transcript"
			>
				{s.messages.map((m, mi) => (
					<LessonMessage key={m.id || `m-${mi}`} message={m} />
				))}
				{busy && !pending && (
					<p className="text-sm text-muted-foreground" data-testid="phone-lesson-busy">
						Claude is replying…
					</p>
				)}
				{s.messages.length === 0 && !busy && <p className="text-sm text-muted-foreground">Nothing said yet. Ask your first question below.</p>}
			</div>
			{s.error && (
				<div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-red-500/40 p-2 text-sm text-red-400" role="alert" data-testid="phone-lesson-error">
					<span className="min-w-0 flex-1 break-words" data-testid="phone-lesson-error-text">{describeLessonError(s.error.message)}</span>
					<button type="button" onClick={s.clearError} className="h-9 shrink-0 rounded-md border px-3 text-foreground active:bg-accent" data-testid="phone-lesson-dismiss-error">
						OK
					</button>
				</div>
			)}
			{!online && (
				<p className="mx-3 mb-2 text-center text-xs text-muted-foreground" data-testid="phone-lesson-offline">
					{NEEDS_MAC}
				</p>
			)}
			{pending ? (
				<div className="max-h-[70dvh] overflow-y-auto border-t px-3 py-3" data-testid="phone-lesson-dock">
					<QuestionDock
						key={pending.toolCallId}
						toolName={pending.tool as "quiz" | "probe" | "ask_user_question" | "explain" | "recall"}
						toolCallId={pending.toolCallId}
						input={pending.input as never}
						expanded
						onExpand={() => {}}
						onSubmit={(output: QuestionAnswerData) => s.submitAnswer(pending.tool, pending.toolCallId, output)}
						initialDraft={s.questionDraft(pending.toolCallId)?.form}
						onSaveDraft={(form) => s.saveQuestionDraft(pending.toolCallId, { form })}
						phase={phases.at(-1) ?? "probe"}
					/>
				</div>
			) : (
				<div className="flex items-end gap-2 border-t px-3 pb-3 pt-3">
					<textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						rows={2}
						placeholder={busy ? "Claude is replying…" : "Ask anything about this"}
						disabled={busy}
						className="min-h-12 flex-1 resize-none rounded-xl border bg-card p-3 text-base disabled:opacity-60"
						data-testid="phone-lesson-text"
					/>
					<button type="button" onClick={send} disabled={!canSend} aria-label="Send" className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-foreground text-background active:opacity-80 disabled:opacity-40" data-testid="phone-lesson-send">
						<SendIcon className="size-5" />
					</button>
				</div>
			)}
		</div>
	);
}

/** One message of the conversation: the learner's words, the teacher's text and answered questions, the study context at the top. */
function LessonMessage({ message: m }: { message: LhViewMessage }): ReactNode {
	if (m.role === "user") {
		const words = m.parts.filter((p) => p.type === "text").map((p) => p.text as string).join("\n");
		const context = m.parts.find((p) => p.type === "data-study-context");
		if (context) return <StudyContextCard data={context.data as StudyContextData} />;
		if (!words) return null;
		return (
			<div className="w-full border-l-2 border-muted-foreground/30 bg-card py-1 pl-3 pr-3 text-sm" data-testid="phone-lesson-you">
				<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">You</div>
				<div className="whitespace-pre-wrap">{words}</div>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-3" data-testid="phone-lesson-teacher">
			{m.parts.map((part, pi) => {
				if (part.type === "text") return <MessageResponse key={(part.id as string) || pi}>{part.text as string}</MessageResponse>;
				if (QUESTION_TOOLS.includes(part.type) && part.state === "output-available") return <AnsweredCard key={pi} answer={part.output as QuestionAnswerData} input={part.input} />;
				return null;
			})}
		</div>
	);
}
