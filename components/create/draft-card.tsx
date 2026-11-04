"use client";

import { Fragment } from "react";
import { SquareIcon, Undo2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CardDraft } from "@/src/core";

export const TYPE_LABEL: Record<CardDraft["type"], string> = {
	basic: "Question",
	basic_reversed: "Both directions",
	process: "Process",
	cloze: "Gap text",
	image_occlusion: "Picture",
};

export const TIER_LABEL = { 1: "Core", 2: "Good to know", 3: "Detail" } as const;

/** Card text: **bold** and the English addition of a Latin term, as plain React (nothing is injected as HTML). */
export function Rich({ text }: { text: string }) {
	return (
		<>
			{text.split(/(\*\*[\s\S]+?\*\*|\[\[en:[\s\S]*?\]\])/g).map((part, i) =>
				part.startsWith("**") ? (
					<b key={i}>{part.slice(2, -2)}</b>
				) : part.startsWith("[[en:") ? (
					<span key={i} className="italic text-muted-foreground">
						{" "}
						({part.slice(5, -2)})
					</span>
				) : (
					<Fragment key={i}>{part}</Fragment>
				),
			)}
		</>
	);
}

/** A gap text with its gaps marked: {{c1::answer}} → the answer in colour. */
export function Gaps({ text }: { text: string }) {
	const parts = text.split(/(\{\{c\d+::[\s\S]*?\}\})/g);
	return (
		<>
			{parts.map((part, i) => {
				const m = /^\{\{c(\d+)::([\s\S]*?)(?:::[\s\S]*)?\}\}$/.exec(part);
				return m ? (
					<span key={i} className="rounded bg-sky-400/15 px-1 text-sky-300" title={`Gap ${m[1]}`}>
						<Rich text={m[2]!} />
					</span>
				) : (
					<Rich key={i} text={part} />
				);
			})}
		</>
	);
}

/** A rendered card picture (a local file of the job, so Next's image optimiser has nothing to do). */
export function Picture({ src, alt, className }: { src: string; alt: string; className: string }) {
	// eslint-disable-next-line @next/next/no-img-element
	return <img src={src} alt={alt} className={`${className} rounded border`} loading="lazy" />;
}

/** The sides of a card as the learner reads them (no controls): used by the card lists and the duplicate review. */
export function CardBody({ c, mediaUrl, pictures = true }: { c: CardDraft; mediaUrl: (file: string) => string; pictures?: boolean }) {
	const picture = pictures && c.image?.file ? mediaUrl(c.image.file) : null;
	return (
		<>
			{c.type === "image_occlusion" ? (
				<>
					<p className={`font-medium ${c.deleted ? "line-through" : ""}`}>{c.header}</p>
					<p className="text-emerald-400">
						<Rich text={c.label} />
					</p>
					{pictures && (
						<div className="mt-1 flex flex-wrap gap-2">
							{c.questionFile && <Picture src={mediaUrl(c.questionFile)} alt="Question picture" className="max-h-48" />}
							{c.answerFile && <Picture src={mediaUrl(c.answerFile)} alt="Answer picture" className="max-h-48" />}
						</div>
					)}
					{c.needsCheck && <p className="mt-1 text-xs text-amber-400">The covered place is a guess — please look at the picture.</p>}
				</>
			) : c.type === "cloze" ? (
				<>
					<p className={`whitespace-pre-wrap ${c.deleted ? "line-through" : ""}`}>
						<Gaps text={c.text} />
					</p>
					{picture && <Picture src={picture} alt="Figure" className="mt-1 max-h-56" />}
				</>
			) : (
				<>
					{picture && c.image?.where === "front" && <Picture src={picture} alt="Figure" className="mb-1 max-h-48" />}
					<p className={`whitespace-pre-wrap font-medium ${c.deleted ? "line-through" : ""}`}>
						<Rich text={c.front} />
					</p>
					<p className="mt-0.5 whitespace-pre-wrap text-emerald-400">
						<Rich text={c.back} />
					</p>
					{picture && c.image?.where === "extra" && <Picture src={picture} alt="Figure" className="mt-1 max-h-48" />}
				</>
			)}
			{c.extra && (
				<p className="mt-1 whitespace-pre-wrap border-l-2 pl-2 text-xs text-muted-foreground">
					<Rich text={c.extra} />
				</p>
			)}
			{c.warnings.length > 0 && !c.deleted && <p className="mt-1 text-xs text-amber-400">{c.warnings.join(" · ")}</p>}
			{c.note && <p className="mt-1 text-xs italic text-muted-foreground">{c.note}</p>}
		</>
	);
}

/** One draft card with its selection box and the throw-away button; `children` (the focus screen's tools) sit under the text. */
export function DraftCard({
	c,
	mediaUrl,
	selected,
	onSelect,
	onToggleDeleted,
	number,
	active,
	onActivate,
	children,
}: {
	c: CardDraft;
	mediaUrl: (file: string) => string;
	selected: boolean;
	onSelect: (on: boolean) => void;
	onToggleDeleted: () => void;
	/** The number of the card on its page (the same number sits on the page picture). */
	number?: number;
	active?: boolean;
	/** The card was clicked (the focus screen shows where it comes from). */
	onActivate?: () => void;
	children?: React.ReactNode;
}) {
	return (
		<li
			className={`flex items-start gap-2 rounded-md border p-3 ${c.deleted ? "opacity-50" : ""} ${active ? "border-sky-400/70 bg-sky-400/5" : ""}`}
			data-testid="draft"
			id={`draft-${c.id}`}
			onClick={onActivate}
		>
			{number !== undefined && <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-sky-500/80 text-xs text-white">{number}</span>}
			{c.adopted || c.deleted ? (
				<SquareIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/40" aria-hidden />
			) : (
				<input type="checkbox" className="mt-1 size-4 shrink-0" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label="Add this card to my cards" />
			)}
			<div className="min-w-0 flex-1 text-sm">
				<p className="mb-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
					<span>{TYPE_LABEL[c.type]}</span>
					<span>{TIER_LABEL[c.tier]}</span>
					{c.manual && <span>Made by you</span>}
					{c.edited && !c.manual && <span>Edited</span>}
				</p>
				<CardBody c={c} mediaUrl={mediaUrl} />
				{children}
			</div>
			{c.adopted ? (
				<span className="shrink-0 text-xs text-emerald-400">In your cards</span>
			) : (
				<Button variant="ghost" size="icon-xs" onClick={onToggleDeleted} title={c.deleted ? "Bring back" : "Throw away"} aria-label={c.deleted ? "Bring back" : "Throw away"}>
					{c.deleted ? <Undo2Icon /> : <XIcon />}
				</Button>
			)}
		</li>
	);
}
