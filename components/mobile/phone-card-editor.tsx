"use client";

import { useState } from "react";
import type { StudyCardView } from "@/src/core";

/**
 * Edit a card's fields on the phone (Slice 10e): one text box per field, HTML as the Mac shows it. Only the fields
 * that changed are handed over. The change is kept on the phone and goes to the Mac with the next update; on an Anki
 * note it reaches the note's other cards too.
 */
export function PhoneCardEditor({
	card,
	busy,
	onSave,
	onCancel,
}: {
	card: StudyCardView;
	busy: boolean;
	onSave: (changed: Record<string, string>) => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState<Record<string, string>>(card.fields);
	const changed = Object.fromEntries(Object.entries(draft).filter(([name, value]) => value !== card.fields[name]));
	const dirty = Object.keys(changed).length > 0;
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="phone-editor">
			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
				{Object.keys(card.fields).map((name) => (
					<label key={name} className="flex flex-col gap-1">
						<span className="text-xs uppercase tracking-widest text-muted-foreground">{name}</span>
						<textarea
							value={draft[name] ?? ""}
							onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.value }))}
							rows={Math.min(10, Math.max(3, (draft[name] ?? "").split("\n").length))}
							spellCheck={false}
							autoCapitalize="off"
							autoCorrect="off"
							data-testid={`phone-field-${name}`}
							className="w-full resize-y rounded-lg border bg-background p-3 font-mono text-base"
						/>
					</label>
				))}
				<p className="text-xs text-muted-foreground" data-testid="phone-editor-note">
					{card.siblings > 0 ? `Also changes ${card.siblings} other card${card.siblings === 1 ? "" : "s"} of this note. ` : ""}
					The change goes to your Mac with the next update.
				</p>
			</div>
			<footer className="grid grid-cols-2 gap-2 border-t px-3 pb-3 pt-3">
				<button type="button" onClick={onCancel} className="h-14 rounded-xl border text-base active:bg-accent" data-testid="phone-edit-cancel">
					Cancel
				</button>
				<button
					type="button"
					disabled={!dirty || busy}
					onClick={() => onSave(changed)}
					className="h-14 rounded-xl bg-foreground text-base font-medium text-background active:opacity-80 disabled:opacity-40"
					data-testid="phone-edit-save"
				>
					Save
				</button>
			</footer>
		</div>
	);
}
