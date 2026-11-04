"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { studyApi as api, postJson } from "@/components/study/api";
import { AddCardForm, CardEditor } from "@/components/create/card-editor";
import { DraftCard } from "@/components/create/draft-card";
import { type Marker, PagePicture } from "@/components/create/page-picture";
import type { Box, CardDraft, CardJobPageView, CardsJobDetail } from "@/src/core";

type Tool =
	| { kind: "draw"; hint: string; done: (box: Box) => void }
	| { kind: "edit"; hint: string; what: "mask" | "figure" | "image"; cardId: string; box: Box };

const patch = (body: object): RequestInit => ({ ...postJson(body), method: "PATCH" });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The checklist of a page: a chip per card; press on one and drag to another to select or unselect everything in between. */
function Checklist({ cards, onSet }: { cards: CardDraft[]; onSet: (ids: string[], include: boolean) => void }) {
	const [drag, setDrag] = useState<{ value: boolean; from: number; to: number } | null>(null);
	const open = cards.flatMap((c, i) => (c.deleted || c.adopted ? [] : [{ c, i }]));
	const covered = (i: number) => drag !== null && i >= Math.min(drag.from, drag.to) && i <= Math.max(drag.from, drag.to);
	const idsOf = (d: NonNullable<typeof drag>) => open.filter(({ i }) => i >= Math.min(d.from, d.to) && i <= Math.max(d.from, d.to)).map(({ c }) => c.id);

	useEffect(() => {
		if (!drag) return;
		const end = () => {
			onSet(idsOf(drag), drag.value);
			setDrag(null);
		};
		window.addEventListener("pointerup", end, { once: true });
		return () => window.removeEventListener("pointerup", end);
		// idsOf closes over `open`, which follows `cards`
	}, [drag, onSet, cards]);

	if (open.length === 0) return null;
	return (
		<div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="checklist">
			<span className="text-muted-foreground">Add to my cards:</span>
			{open.map(({ c, i }) => {
				const on = covered(i) ? drag!.value : c.include;
				return (
					<button
						key={c.id}
						type="button"
						className={`size-6 rounded-full border text-xs ${on ? "border-sky-400 bg-sky-500/80 text-white" : "text-muted-foreground"}`}
						aria-pressed={on}
						aria-label={`Select card ${i + 1}`}
						onPointerDown={(e) => {
							e.preventDefault();
							setDrag({ value: !c.include, from: i, to: i });
						}}
						onPointerEnter={() => drag && setDrag({ ...drag, to: i })}
					>
						{i + 1}
					</button>
				);
			})}
			<Button variant="ghost" size="xs" onClick={() => onSet(open.map(({ c }) => c.id), true)}>
				All
			</Button>
			<Button variant="ghost" size="xs" onClick={() => onSet(open.map(({ c }) => c.id), false)}>
				None
			</Button>
			<Button
				variant="ghost"
				size="xs"
				onClick={() => {
					onSet(open.filter(({ c }) => c.tier !== 1).map(({ c }) => c.id), false);
					onSet(open.filter(({ c }) => c.tier === 1).map(({ c }) => c.id), true);
				}}
			>
				Core only
			</Button>
		</div>
	);
}

/**
 * The focus screen: ONE page of the PDF with the page picture and the numbered places its cards come from on one
 * side, the cards on the other — to look at, rewrite, add to, throw away, and choose for adoption. Pictures of
 * masks and figures can be moved by dragging a box on the page.
 */
export function CardsFocus({
	jobId,
	detail,
	page,
	onPage,
	onClose,
	onReload,
	onStart,
}: {
	jobId: string;
	detail: CardsJobDetail;
	page: number;
	onPage: (n: number) => void;
	onClose: () => void;
	/** Fetch the job again (and tell the job list). */
	onReload: () => Promise<void>;
	/** Run a page again. */
	onStart: (body: object) => Promise<void>;
}) {
	const p: CardJobPageView | undefined = detail.pages.find((x) => x.page === page);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [tool, setTool] = useState<Tool | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const reload = useRef(onReload);
	reload.current = onReload;

	const mediaUrl = useCallback((file: string) => `/api/create/jobs/${jobId}/media/${encodeURIComponent(file)}`, [jobId]);
	const pages = detail.pages.map((x) => x.page);
	const at = pages.indexOf(page);
	const running = detail.job.running;

	// a tool or an editor belongs to the page it was started on
	useEffect(() => {
		setTool(null);
		setEditingId(null);
		setActiveId(null);
		setError(null);
	}, [page]);

	const call = useCallback(async <T,>(run: () => Promise<T>): Promise<T | undefined> => {
		setBusy(true);
		setError(null);
		try {
			const out = await run();
			await reload.current();
			return out;
		} catch (e) {
			setError(message(e));
			return undefined;
		} finally {
			setBusy(false);
		}
	}, []);

	const cards = useMemo(() => p?.cards ?? [], [p]);
	const numberOf = (c: CardDraft) => cards.indexOf(c) + 1;

	const markers = useMemo<Marker[]>(() => {
		const out: Marker[] = [];
		cards.forEach((c, i) => {
			if (c.deleted) return;
			const label = String(i + 1);
			const active = c.id === activeId;
			if (c.type === "image_occlusion") {
				const mask = c.boxes[0];
				if (mask && !(tool?.kind === "edit" && tool.cardId === c.id && tool.what === "mask")) out.push({ id: c.id, box: mask, label, kind: "mask", active });
				if (active && c.figureBbox) out.push({ id: c.id, box: c.figureBbox, label, kind: "figure" });
			} else {
				if (c.sourceBbox) out.push({ id: c.id, box: c.sourceBbox, label, kind: "source", active });
				if (active && c.image?.bbox) out.push({ id: c.id, box: c.image.bbox, label, kind: "figure" });
			}
		});
		return out;
	}, [cards, activeId, tool]);

	const setInclude = useCallback(
		(ids: string[], include: boolean) => {
			if (ids.length === 0) return;
			void call(() => api(`/api/create/jobs/${jobId}/include`, postJson({ cardIds: ids, include })));
		},
		[call, jobId],
	);

	function activate(id: string) {
		setActiveId(id);
		document.getElementById(`draft-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}

	function startEdit(c: CardDraft, what: "mask" | "figure" | "image") {
		const box = what === "mask" && c.type === "image_occlusion" ? c.boxes[0] : what === "figure" && c.type === "image_occlusion" ? c.figureBbox : c.image?.bbox;
		if (!box) return;
		setActiveId(c.id);
		setTool({ kind: "edit", cardId: c.id, what, box: [...box] as Box, hint: what === "mask" ? "Drag the orange box over the part to cover." : "Drag the box over the part of the page the picture should show." });
	}

	async function saveTool() {
		if (tool?.kind !== "edit") return;
		const { cardId, what, box } = tool;
		const url = `/api/create/jobs/${jobId}/cards/${cardId}/${what === "image" ? "image" : "mask"}`;
		const body = what === "mask" ? { bbox: box } : what === "figure" ? { figure: box } : { bbox: box };
		if ((await call(() => api(url, postJson(body)))) !== undefined) setTool(null);
	}

	const pickRegion = (target: "mask" | "figure", done: (box: Box) => void) =>
		setTool({ kind: "draw", hint: target === "mask" ? "Draw the area to cover on the page." : "Draw the part of the page the picture should show.", done: (box) => { done(box); setTool(null); } });

	if (!p) return null;
	const done = p.status === "done";
	return (
		<div className="flex flex-col gap-3" data-testid="cards-focus">
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="ghost" size="sm" onClick={onClose}>
					<ArrowLeftIcon /> Pages
				</Button>
				<Button variant="outline" size="icon-sm" disabled={at <= 0} onClick={() => onPage(pages[at - 1]!)} aria-label="Previous page">
					<ChevronLeftIcon />
				</Button>
				<span className="text-sm font-medium" data-testid="focus-page">
					Page {page} of {detail.job.nPages}
				</span>
				<Button variant="outline" size="icon-sm" disabled={at < 0 || at >= pages.length - 1} onClick={() => onPage(pages[at + 1]!)} aria-label="Next page">
					<ChevronRightIcon />
				</Button>
				{p.topic && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{p.topic}</span>}
				{!running && (p.status === "done" || p.status === "error") && (
					<Button variant="outline" size="xs" className="ml-auto" onClick={() => void onStart({ pages: [page] })}>
						{p.status === "error" ? "Try again" : "Run again"}
					</Button>
				)}
			</div>

			{error && (
				<p className="rounded-md border border-red-500/40 p-2 text-sm text-red-400" role="alert">
					{error}
				</p>
			)}

			<div className="grid gap-4 lg:grid-cols-2">
				<div className="flex flex-col gap-2 lg:sticky lg:top-2 lg:self-start">
					{tool && (
						<div className="flex flex-wrap items-center gap-2 rounded-md border border-orange-400/60 p-2 text-xs" role="status" data-testid="tool-banner">
							<span className="flex-1">{tool.hint}</span>
							{tool.kind === "edit" && (
								<Button size="xs" disabled={busy} onClick={() => void saveTool()} data-testid="tool-save">
									{busy ? "Drawing…" : "Save"}
								</Button>
							)}
							<Button size="xs" variant="ghost" onClick={() => setTool(null)}>
								Cancel
							</Button>
						</div>
					)}
					<PagePicture
						src={`/api/create/jobs/${jobId}/pages/${page}/image`}
						alt={`Page ${page}`}
						markers={markers}
						onMarker={activate}
						tool={
							!tool
								? undefined
								: tool.kind === "draw"
									? { mode: "draw", onDraw: tool.done }
									: { mode: "edit", box: tool.box, onEdit: (box) => setTool({ ...tool, box }) }
						}
					/>
				</div>

				<div className="flex min-w-0 flex-col gap-3">
					{!done && (
						<p className="text-sm text-muted-foreground">
							{p.status === "running" ? "This page is being worked on…" : p.status === "error" ? <span className="text-red-400">This page failed — {p.error}</span> : "This page has not been processed yet."}
						</p>
					)}
					{done && p.skipped && <p className="text-sm text-muted-foreground">Skipped: {p.skipReason || "nothing to learn on this page"}. You can still add cards by hand.</p>}
					{done && <Checklist cards={cards} onSet={setInclude} />}
					<ul className="flex flex-col gap-2">
						{cards.map((c, i) => (
							<DraftCard
								key={c.id}
								c={c}
								number={i + 1}
								active={c.id === activeId}
								onActivate={() => setActiveId(c.id)}
								mediaUrl={mediaUrl}
								selected={c.include}
								onSelect={(on) => setInclude([c.id], on)}
								onToggleDeleted={() => void call(() => api(`/api/create/jobs/${jobId}/cards/${c.id}`, patch({ deleted: !c.deleted })))}
							>
								{editingId === c.id ? (
									<CardEditor
										c={c}
										onCancel={() => setEditingId(null)}
										onSave={async (changes) => {
											await api(`/api/create/jobs/${jobId}/cards/${c.id}`, patch(changes));
											setEditingId(null);
											await reload.current();
										}}
									/>
								) : (
									!c.deleted &&
									!c.adopted && (
										<div className="mt-2 flex flex-wrap gap-1">
											<Button variant="outline" size="xs" disabled={busy || tool !== null} onClick={() => setEditingId(c.id)} data-testid="card-edit">
												Edit
											</Button>
											{c.type === "image_occlusion" && (
												<>
													<Button variant="outline" size="xs" disabled={busy || tool !== null} onClick={() => startEdit(c, "mask")} data-testid="card-move-mask">
														Move mask
													</Button>
													<Button variant="outline" size="xs" disabled={busy || tool !== null} onClick={() => startEdit(c, "figure")}>
														Picture part
													</Button>
												</>
											)}
											{c.type !== "image_occlusion" && c.image && (
												<Button variant="outline" size="xs" disabled={busy || tool !== null} onClick={() => startEdit(c, "image")}>
													Picture part
												</Button>
											)}
										</div>
									)
								)}
							</DraftCard>
						))}
					</ul>
					{done && cards.length === 0 && !p.skipped && <p className="text-sm text-muted-foreground">No cards on this page.</p>}
					{p.dropped > 0 && (
						<p className="text-xs text-muted-foreground">
							{p.dropped} card{p.dropped === 1 ? "" : "s"} of the model {p.dropped === 1 ? "was" : "were"} left out (not usable).
						</p>
					)}
					{done && (
						<details className="rounded-md border" data-testid="add-card">
							<summary className="cursor-pointer px-3 py-2 text-sm">Add a card yourself</summary>
							<div className="p-3 pt-0">
								<AddCardForm
									picking={tool !== null}
									onPick={pickRegion}
									onSubmit={async (payload) => {
										const out = await api<{ cards: CardDraft[] }>(`/api/create/jobs/${jobId}/pages/${page}/cards`, postJson(payload));
										setActiveId(out.cards.at(-1)?.id ?? null);
										await reload.current();
									}}
								/>
							</div>
						</details>
					)}
				</div>
			</div>
		</div>
	);
}
