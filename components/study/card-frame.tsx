"use client";

import { useEffect, useMemo, useRef } from "react";
import { applyPicked, cardDocument } from "@/src/core";
import type { StudyCardView } from "@/src/core";

/** A throwaway nonce for one MCQ front; the card's own HTML is fixed before it exists, so it cannot know it. */
export function newNonce(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The card in a sandboxed iframe: card HTML is deck content, never trusted. No scripts —
 * except an MCQ front, which runs our one fixed script (allowed by a nonce in its CSP, so
 * script tags inside the deck content stay dead) to report which options were clicked.
 */
export function CardFrame({
	card,
	revealed,
	picked,
	onPick,
}: {
	card: StudyCardView;
	revealed: boolean;
	picked: readonly string[];
	onPick: (letters: string[]) => void;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
	const interactive = card.kind === "mcq" && !revealed;
	const nonce = useMemo(() => (interactive ? newNonce() : undefined), [interactive]);
	const srcDoc = useMemo(
		() =>
			cardDocument(revealed ? (card.kind === "mcq" ? applyPicked(card.back, picked) : card.back) : card.front, {
				dark,
				mcqNonce: nonce,
			}),
		[card, revealed, picked, dark, nonce],
	);

	// the sandboxed page reports its picks by postMessage — accept only this iframe, only letters A–D
	useEffect(() => {
		if (!interactive) return;
		const onMessage = (e: MessageEvent) => {
			if (e.source !== frame.current?.contentWindow) return;
			const letters = (e.data as { lhMcq?: unknown } | null)?.lhMcq;
			if (!Array.isArray(letters)) return;
			onPick(letters.filter((k): k is string => typeof k === "string" && /^[A-D]$/.test(k)));
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [interactive, onPick]);

	// A click inside the iframe moves keyboard focus into it, where the review shortcuts cannot
	// hear it — hand the focus straight back to the page.
	useEffect(() => {
		const reclaim = () => {
			setTimeout(() => {
				if (document.activeElement === frame.current) window.focus();
			}, 0);
		};
		window.addEventListener("blur", reclaim);
		return () => window.removeEventListener("blur", reclaim);
	}, []);

	return (
		<div className="min-h-0 flex-1" data-testid="study-card">
			<iframe
				ref={frame}
				title="Card"
				sandbox={interactive ? "allow-scripts" : ""}
				srcDoc={srcDoc}
				className="size-full border-0 bg-transparent"
				data-kind={card.kind}
				data-split={card.split}
			/>
		</div>
	);
}

