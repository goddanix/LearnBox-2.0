"use client";

import { Fragment, type ReactNode } from "react";

/**
 * A topic note as the learner will see it in Obsidian, near enough to judge it: the Markdown the notes use (the
 * "Kernaussagen" box, headings, lists, **bold**, pictures, links to PDF pages), drawn as plain React — nothing is
 * injected as HTML. `figureUrl` gives the address of a picture by the file name the note embeds.
 */

/** `**bold**`, `*italic*` and `[[target#page=3|label]]` (a page link: only its label is shown) in one line of text. */
function Inline({ text }: { text: string }): ReactNode {
	return text.split(/(\*\*[^*]+\*\*|\[\[[^\]]+\]\]|\*[^*\s][^*]*\*)/g).map((part, i) => {
		if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <b key={i}>{part.slice(2, -2)}</b>;
		if (part.startsWith("[[") && part.endsWith("]]")) {
			const inner = part.slice(2, -2);
			const label = inner.includes("|") ? inner.slice(inner.indexOf("|") + 1) : inner.replace(/#page=\d+$/, "");
			return (
				<span key={i} className="rounded bg-sky-400/10 px-1 text-sky-300" title={inner.split("|")[0]}>
					{label}
				</span>
			);
		}
		if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <i key={i}>{part.slice(1, -1)}</i>;
		return <Fragment key={i}>{part}</Fragment>;
	});
}

type Block =
	| { kind: "heading"; level: number; text: string }
	| { kind: "list"; items: string[] }
	| { kind: "callout"; title: string; items: string[] }
	| { kind: "figure"; file: string }
	| { kind: "table"; head: string[]; rows: string[][] }
	| { kind: "text"; text: string };

/** The cells of a table row "| a | b |". */
const cells = (line: string): string[] =>
	line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((c) => c.trim());

const isRule = (line: string | undefined): boolean => line !== undefined && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

/** The lines of a note as blocks. */
export function noteBlocks(markdown: string): Block[] {
	const blocks: Block[] = [];
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();
		if (!trimmed) continue;
		const callout = /^>\s*\[!([\w-]+)\]\s*(.*)$/.exec(trimmed);
		if (callout) {
			const items: string[] = [];
			while (i + 1 < lines.length && lines[i + 1]!.trim().startsWith(">")) items.push(lines[++i]!.trim().replace(/^>\s?/, "").replace(/^-\s+/, ""));
			blocks.push({ kind: "callout", title: callout[2] || callout[1]!, items });
			continue;
		}
		const embed = /^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(trimmed);
		if (embed) {
			blocks.push({ kind: "figure", file: embed[1]! });
			continue;
		}
		if (trimmed.startsWith("|") && isRule(lines[i + 1])) {
			const rows: string[][] = [];
			i++; // the rule under the header
			while (i + 1 < lines.length && lines[i + 1]!.trim().startsWith("|")) rows.push(cells(lines[++i]!));
			blocks.push({ kind: "table", head: cells(trimmed), rows });
			continue;
		}
		const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
		if (heading) {
			blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
			continue;
		}
		if (/^[-*]\s+/.test(trimmed)) {
			const items = [trimmed.replace(/^[-*]\s+/, "")];
			while (i + 1 < lines.length && /^[-*]\s+/.test(lines[i + 1]!.trim())) items.push(lines[++i]!.trim().replace(/^[-*]\s+/, ""));
			blocks.push({ kind: "list", items });
			continue;
		}
		blocks.push({ kind: "text", text: trimmed });
	}
	return blocks;
}

export function NotePreview({ markdown, figureUrl }: { markdown: string; figureUrl: (file: string) => string }) {
	return (
		<div className="flex flex-col gap-2 text-sm" data-testid="note-preview">
			{noteBlocks(markdown).map((b, i) => {
				switch (b.kind) {
					case "heading":
						return (
							<p key={i} className={b.level === 1 ? "text-base font-semibold" : "font-medium"}>
								<Inline text={b.text} />
							</p>
						);
					case "list":
						return (
							<ul key={i} className="ml-5 list-disc">
								{b.items.map((item, j) => (
									<li key={j}>
										<Inline text={item} />
									</li>
								))}
							</ul>
						);
					case "callout":
						return (
							<div key={i} className="rounded-md border-l-2 border-sky-400/70 bg-sky-400/5 px-3 py-2">
								<p className="mb-1 text-xs font-medium uppercase tracking-wide text-sky-300">{b.title}</p>
								<ul className="ml-4 list-disc">
									{b.items.map((item, j) => (
										<li key={j}>
											<Inline text={item} />
										</li>
									))}
								</ul>
							</div>
						);
					case "table":
						return (
							<div key={i} className="overflow-x-auto">
								<table className="border-collapse text-left">
									<thead>
										<tr>
											{b.head.map((c, j) => (
												<th key={j} className="border-b px-2 py-1 font-medium">
													<Inline text={c} />
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{b.rows.map((row, j) => (
											<tr key={j}>
												{row.map((c, k) => (
													<td key={k} className="border-b border-border/50 px-2 py-1 align-top">
														<Inline text={c} />
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						);
					case "figure":
						return (
							// eslint-disable-next-line @next/next/no-img-element
							<img key={i} src={figureUrl(b.file)} alt={b.file} className="max-h-72 w-auto self-start rounded border" loading="lazy" />
						);
					default:
						return (
							<p key={i}>
								<Inline text={b.text} />
							</p>
						);
				}
			})}
		</div>
	);
}
