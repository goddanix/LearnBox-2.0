"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Box, CardDraft } from "@/src/core";
import { TIER_LABEL } from "@/components/create/draft-card";

const field = "flex flex-col gap-1 text-xs text-muted-foreground";
const control = "rounded-md border bg-background px-2 py-1.5 text-sm text-foreground";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function TierSelect({ value, onChange }: { value: number; onChange: (tier: number) => void }) {
	return (
		<label className={field}>
			Importance
			<select className={`${control} h-9`} value={value} onChange={(e) => onChange(Number(e.target.value))}>
				{([1, 2, 3] as const).map((t) => (
					<option key={t} value={t}>
						{TIER_LABEL[t]}
					</option>
				))}
			</select>
		</label>
	);
}

/** The texts of a card that can be changed, by type: [field, label, rows]. */
function fieldsOf(c: CardDraft): [string, string, number][] {
	if (c.type === "image_occlusion") return [["header", "Question above the picture", 1], ["label", "Answer (the covered word)", 1]];
	if (c.type === "cloze") return [["text", "Gap text — gaps as {{c1::answer}}", 3]];
	return [["front", "Question", 2], ["back", "Answer", 3]];
}

/** Change the texts, importance and tags of one draft card. The server checks them; its message is shown as it is. */
export function CardEditor({ c, onSave, onCancel }: { c: CardDraft; onSave: (changes: Record<string, string | number>) => Promise<void>; onCancel: () => void }) {
	const initial: Record<string, string | number> = { ...Object.fromEntries(fieldsOf(c).map(([k]) => [k, (c as unknown as Record<string, string>)[k] ?? ""])), extra: c.extra, tags: c.tags.join(", "), tier: c.tier };
	const [values, setValues] = useState(initial);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const set = (key: string, value: string | number) => setValues((prev) => ({ ...prev, [key]: value }));

	async function save() {
		const changes = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== initial[k]));
		if (Object.keys(changes).length === 0) return onCancel();
		setBusy(true);
		setError(null);
		try {
			await onSave(changes);
		} catch (e) {
			setError(message(e));
			setBusy(false);
		}
	}

	return (
		<div className="mt-1 flex flex-col gap-2" data-testid="card-editor">
			{fieldsOf(c).map(([key, label, rows]) => (
				<label key={key} className={field}>
					{label}
					<textarea className={control} rows={rows} value={String(values[key])} onChange={(e) => set(key, e.target.value)} />
				</label>
			))}
			<label className={field}>
				Extra (shown under the answer)
				<textarea className={control} rows={2} value={String(values.extra)} onChange={(e) => set("extra", e.target.value)} />
			</label>
			<div className="grid grid-cols-2 gap-2">
				<TierSelect value={Number(values.tier)} onChange={(t) => set("tier", t)} />
				<label className={field}>
					Tags (commas)
					<Input value={String(values.tags)} onChange={(e) => set("tags", e.target.value)} />
				</label>
			</div>
			{error && (
				<p className="text-xs text-red-400" role="alert">
					{error}
				</p>
			)}
			<div className="flex gap-2">
				<Button size="xs" disabled={busy} onClick={() => void save()} data-testid="card-save">
					Save
				</Button>
				<Button size="xs" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

type NewType = "basic" | "basic_reversed" | "image_occlusion";

/**
 * Make a card by hand on the page shown: a question and answer (also both ways), or a picture card — draw the area
 * to cover on the page, and optionally the part of the page the picture shows.
 */
export function AddCardForm({
	onPick,
	picking,
	onSubmit,
}: {
	/** Let the learner draw a box on the page picture; `done` gets it. */
	onPick: (target: "mask" | "figure", done: (box: Box) => void) => void;
	picking: boolean;
	onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
	const [type, setType] = useState<NewType>("basic");
	const [front, setFront] = useState("");
	const [back, setBack] = useState("");
	const [label, setLabel] = useState("");
	const [tier, setTier] = useState(2);
	const [area, setArea] = useState<Box | null>(null);
	const [figure, setFigure] = useState<Box | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit() {
		setBusy(true);
		setError(null);
		try {
			await onSubmit(type === "image_occlusion" ? { type, label, bbox: area, ...(figure ? { figure: { bbox: figure } } : {}), tier } : { type, front, back, tier });
			setFront("");
			setBack("");
			setLabel("");
			setArea(null);
			setFigure(null);
		} catch (e) {
			setError(message(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form
			className="flex flex-col gap-2 rounded-md border bg-card p-3"
			data-testid="add-card-form"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<div className="grid grid-cols-2 gap-2">
				<label className={field}>
					Card type
					<select className={`${control} h-9`} value={type} onChange={(e) => setType(e.target.value as NewType)} data-testid="add-card-type">
						<option value="basic">Question and answer</option>
						<option value="basic_reversed">Both directions</option>
						<option value="image_occlusion">Cover a part of the picture</option>
					</select>
				</label>
				<TierSelect value={tier} onChange={setTier} />
			</div>
			{type === "image_occlusion" ? (
				<>
					<label className={field}>
						Answer (the covered word)
						<Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Aortic arch" />
					</label>
					<div className="flex flex-wrap items-center gap-2 text-xs">
						<Button type="button" size="xs" variant="outline" disabled={picking} onClick={() => onPick("mask", setArea)} data-testid="pick-area">
							{area ? "Draw the area again" : "Draw the area to cover"}
						</Button>
						<Button type="button" size="xs" variant="outline" disabled={picking} onClick={() => onPick("figure", setFigure)}>
							{figure ? "Draw the picture part again" : "Choose the picture part (optional)"}
						</Button>
						<span className="text-muted-foreground">
							{area ? "Area chosen" : "Draw the area on the page first"}
							{figure && " · picture part chosen"}
						</span>
					</div>
				</>
			) : (
				<>
					<label className={field}>
						Question
						<textarea className={control} rows={2} value={front} onChange={(e) => setFront(e.target.value)} />
					</label>
					<label className={field}>
						Answer
						<textarea className={control} rows={2} value={back} onChange={(e) => setBack(e.target.value)} />
					</label>
				</>
			)}
			{error && (
				<p className="text-xs text-red-400" role="alert">
					{error}
				</p>
			)}
			<Button type="submit" size="sm" className="self-start" disabled={busy || picking} data-testid="add-card-submit">
				{busy ? "Adding…" : "Add the card"}
			</Button>
		</form>
	);
}
