"use client";

import { useRef, useState } from "react";
import { type Box, boxBetween, HANDLES, type Handle, handlePoint, isDrawn, moveBox, resizeBox } from "@/src/core";

/** A box drawn on the page picture: where a card comes from, the part a mask covers, or the part of the page a picture shows. */
export interface Marker {
	id: string;
	box: Box;
	/** The number of the card (shown on the box). */
	label: string;
	kind: "source" | "mask" | "figure";
	active?: boolean;
}

const KIND_STYLE: Record<Marker["kind"], string> = {
	source: "border-sky-400/70",
	mask: "border-orange-400",
	figure: "border-emerald-400/70 border-dashed",
};

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
const frame = (b: Box): React.CSSProperties => ({ left: pct(b[0]), top: pct(b[1]), width: pct(b[2] - b[0]), height: pct(b[3] - b[1]) });

/** How far (px) the handles sit outside the box. */
const HANDLE_GAP = 8;

type Drag = { kind: Handle | "move"; from: [number, number]; box: Box };

/**
 * The rendered page with the boxes of its cards on it. With a tool, the learner draws a new box (`draw`) or
 * moves and resizes one (`edit`: drag the box, or one of its eight handles). Boxes are page-normalised.
 */
export function PagePicture({
	src,
	alt,
	markers,
	onMarker,
	tool,
}: {
	src: string;
	alt: string;
	markers: Marker[];
	onMarker: (id: string) => void;
	tool?: { mode: "draw"; onDraw: (box: Box) => void } | { mode: "edit"; box: Box; onEdit: (box: Box) => void };
}) {
	const layer = useRef<HTMLDivElement>(null);
	const [failed, setFailed] = useState(false);
	const [anchor, setAnchor] = useState<[number, number] | null>(null);
	const [live, setLive] = useState<Box | null>(null);
	const drag = useRef<Drag | null>(null);

	const point = (e: React.PointerEvent): [number, number] => {
		const r = layer.current!.getBoundingClientRect();
		return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
	};

	function down(e: React.PointerEvent<HTMLDivElement>) {
		if (!tool) return;
		if (tool.mode === "draw") {
			const p = point(e);
			setAnchor(p);
			setLive(boxBetween(p, p));
		} else {
			const kind = (e.target as HTMLElement).dataset.handle as Handle | "move" | undefined;
			if (!kind) return;
			drag.current = { kind, from: point(e), box: tool.box };
		}
		e.currentTarget.setPointerCapture(e.pointerId);
	}

	function move(e: React.PointerEvent<HTMLDivElement>) {
		if (tool?.mode === "draw" && anchor) setLive(boxBetween(anchor, point(e)));
		const d = drag.current;
		if (tool?.mode === "edit" && d) {
			const p = point(e);
			const [dx, dy] = [p[0] - d.from[0], p[1] - d.from[1]];
			tool.onEdit(d.kind === "move" ? moveBox(d.box, dx, dy) : resizeBox(d.box, d.kind, dx, dy));
		}
	}

	function up(e: React.PointerEvent<HTMLDivElement>) {
		if (tool?.mode === "draw" && anchor) {
			const box = boxBetween(anchor, point(e));
			setAnchor(null);
			setLive(null);
			if (isDrawn(box)) tool.onDraw(box);
		}
		drag.current = null;
	}

	if (failed) return <p className="rounded-md border p-4 text-sm text-muted-foreground">The picture of this page is not available yet — it is made when the page is processed.</p>;

	return (
		<div className="relative w-full select-none" data-testid="page-picture">
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img src={src} alt={alt} className="block h-auto w-full rounded border" draggable={false} onError={() => setFailed(true)} />
			{markers.map((m) => (
				<button
					key={m.id + m.kind}
					type="button"
					className={`absolute border-2 ${KIND_STYLE[m.kind]} ${m.active ? "bg-sky-400/20" : "bg-transparent"} ${tool ? "pointer-events-none" : ""}`}
					style={frame(m.box)}
					onClick={() => onMarker(m.id)}
					aria-label={`Card ${m.label}`}
				>
					{m.kind !== "figure" && <span className="absolute -left-0.5 -top-5 rounded-sm bg-sky-500/90 px-1 text-[11px] leading-4 text-white">{m.label}</span>}
				</button>
			))}
			{tool && (
				<div
					ref={layer}
					className={`absolute inset-0 touch-none ${tool.mode === "draw" ? "cursor-crosshair bg-black/10" : ""}`}
					onPointerDown={down}
					onPointerMove={move}
					onPointerUp={up}
					data-testid={`page-tool-${tool.mode}`}
				>
					{live && <div className="pointer-events-none absolute border-2 border-dashed border-orange-400 bg-orange-400/20" style={frame(live)} />}
					{tool.mode === "edit" && (
						<>
							{/* the ::before makes a tiny box easy to grab; the handles sit just outside the box, so they never cover it */}
							<div
								data-handle="move"
								className="absolute cursor-move border-2 border-orange-400 bg-orange-400/20 before:absolute before:-inset-1.5 before:content-['']"
								style={frame(tool.box)}
							/>
							{HANDLES.map((h) => {
								const [x, y] = handlePoint(tool.box, h);
								const out = (axis: "w" | "n") => (h.includes(axis) ? -HANDLE_GAP : h.includes(axis === "w" ? "e" : "s") ? HANDLE_GAP : 0);
								return (
									<div
										key={h}
										data-handle={h}
										className="absolute size-3 rounded-sm border border-white bg-orange-500"
										style={{ left: pct(x), top: pct(y), transform: `translate(calc(-50% + ${out("w")}px), calc(-50% + ${out("n")}px))`, cursor: `${h}-resize` }}
									/>
								);
							})}
						</>
					)}
				</div>
			)}
		</div>
	);
}
