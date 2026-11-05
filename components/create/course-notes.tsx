"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, LinkIcon, NotebookPenIcon, PencilIcon, RefreshCwIcon, SaveIcon, UnlinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { studyApi as api, postJson } from "@/components/study/api";
import { NotePreview } from "@/components/create/note-preview";
import type { CreateCourse, LinkResult, LinkStatus, NotesView, SavedNotes, TopicNote, VaultInfo } from "@/src/core";

const put = (body: object): RequestInit => ({ ...postJson(body), method: "PUT" });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a written note rests on, in a line. */
function meta(it: TopicNote): string {
	switch (it.kind) {
		case "note":
			return `${plural(it.words, "word")} · ${plural(it.cards, "card")} · ${plural(it.pages, "page")}${it.figures.length > 0 ? ` · ${plural(it.figures.length, "figure")}` : ""}`;
		case "skipped":
			return it.skipReason;
		case "error":
			return it.error;
		default:
			return "waiting…";
	}
}

/** Where the Obsidian vault is: shown, and changed on request. */
function VaultPath({ vault, onChanged }: { vault: VaultInfo | null; onChanged: (vault: VaultInfo) => void }) {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	if (!vault) return null;

	async function save(path: string) {
		setError(null);
		try {
			onChanged((await api<{ vault: VaultInfo }>("/api/create/vault", put({ path }))).vault);
			setEditing(false);
		} catch (e) {
			setError(message(e));
		}
	}
	return (
		<div className="flex flex-col gap-1.5 text-sm" data-testid="vault-path">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-muted-foreground">Vault:</span>
				<code className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 text-xs">{vault.path}</code>
				{!vault.exists && <span className="text-xs text-muted-foreground">(not there yet — it is created when you save)</span>}
				{!editing && (
					<Button size="xs" variant="ghost" onClick={() => (setText(vault.path), setEditing(true))} data-testid="vault-change">
						Change
					</Button>
				)}
			</div>
			{editing && (
				<form
					className="flex flex-wrap items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						void save(text);
					}}
				>
					<Input value={text} onChange={(e) => setText(e.target.value)} className="min-w-64 flex-1" placeholder="/Users/…/Medizinstudium" aria-label="Vault folder" autoFocus />
					<Button type="submit" size="sm">
						Use this folder
					</Button>
					<Button type="button" size="sm" variant="outline" onClick={() => void save("")} disabled={!vault.custom} title={vault.defaultPath}>
						Back to the default
					</Button>
					<Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
						Cancel
					</Button>
				</form>
			)}
			{error && (
				<p className="text-xs text-red-400" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

/** One written note: its text as Obsidian shows it, or to be edited. */
function NoteBody({ courseId, item, locked, onSaved }: { courseId: string; item: TopicNote; locked: boolean; onSaved: () => void }) {
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const figureUrl = (file: string) => `/api/create/courses/${courseId}/notes/media/${encodeURIComponent(file)}`;

	async function save() {
		if (draft === null) return;
		setError(null);
		try {
			await api(`/api/create/courses/${courseId}/notes/${item.id}`, put({ markdown: draft }));
			setDraft(null);
			onSaved();
		} catch (e) {
			setError(message(e));
		}
	}
	if (item.kind !== "note") return null;
	return (
		<div className="flex flex-col gap-2 border-t pt-2" data-testid="note-body">
			{draft === null ? (
				<>
					<NotePreview markdown={item.markdown} figureUrl={figureUrl} />
					<div>
						<Button size="xs" variant="outline" disabled={locked} onClick={() => setDraft(item.markdown)} data-testid="note-edit">
							<PencilIcon /> Edit the text
						</Button>
					</div>
				</>
			) : (
				<>
					<Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(24, Math.max(8, draft.split("\n").length + 1))} className="font-mono text-xs" aria-label={`Text of the note ${item.topic}`} data-testid="note-text" />
					<p className="text-xs text-muted-foreground">Obsidian Markdown. Pictures are <code>![[file.png|560]]</code>, links to a PDF page <code>[[File.pdf#page=3|label]]</code>.</p>
					<div className="flex gap-2">
						<Button size="xs" onClick={() => void save()} data-testid="note-text-save">
							Save the text
						</Button>
						<Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
							Cancel
						</Button>
					</div>
				</>
			)}
			{error && (
				<p className="text-xs text-red-400" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

const linkLine = (r: LinkResult): string =>
	`${plural(r.links, "link")} between ${plural(r.linked, "note")} (of ${r.notes} read, ${r.own} written by this app) · ${r.llm ? (r.llmFailed > 0 ? `checked by Claude, ${plural(r.llmFailed, "batch", "batches")} by similarity` : "checked by Claude") : "chosen by similarity"} · ${plural(r.written, "note")} updated${r.removed > 0 ? `, ${plural(r.removed, "note")} cleaned` : ""}`;

/** Linking the whole vault: related notes get a section of links, so Obsidian's graph shows how the topics connect. */
function LinkVault({ vault }: { vault: VaultInfo | null }) {
	const [status, setStatus] = useState<LinkStatus | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(async () => {
		try {
			setStatus((await api<{ link: LinkStatus }>("/api/create/vault/link")).link);
		} catch (e) {
			setError(message(e));
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);
	const running = status?.state === "running";
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => void load(), 1500);
		return () => clearInterval(timer);
	}, [running, load]);

	async function start() {
		setError(null);
		setNote(null);
		try {
			await api("/api/create/vault/link", postJson({ llm: true }));
			await load();
		} catch (e) {
			setError(message(e));
		}
	}
	async function remove() {
		setError(null);
		try {
			const out = await api<{ removed: number }>("/api/create/vault/unlink", postJson({}));
			setNote(`Links removed from ${plural(out.removed, "note")}.`);
		} catch (e) {
			setError(message(e));
		}
	}
	return (
		<div className="flex flex-col gap-2 border-t pt-3" data-testid="vault-link">
			<h4 className="text-sm font-medium">Link the vault</h4>
			<p className="text-xs text-muted-foreground">
				Related notes — across your courses too — get a section “Verwandte Themen” with links, so Obsidian’s graph shows how the topics connect. Claude checks what looks related. Only notes this app wrote are changed; what you wrote under “Eigene Notizen” stays.
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<Button size="sm" variant="outline" disabled={running || !vault?.exists} onClick={() => void start()} data-testid="vault-link-start" title={vault?.exists ? "" : "Save notes into the vault first"}>
					<LinkIcon /> {running ? "Linking…" : "Link the vault"}
				</Button>
				<Button size="sm" variant="ghost" disabled={running || !vault?.exists} onClick={() => void remove()} data-testid="vault-unlink">
					<UnlinkIcon /> Remove the links
				</Button>
				{running && status && (
					<span className="text-xs text-muted-foreground" role="status">
						{status.stage}
						{status.total > 0 ? ` — ${status.done} of ${status.total}` : "…"}
					</span>
				)}
			</div>
			{status?.state === "error" && (
				<p className="text-sm text-red-400" role="alert">
					{status.error}
				</p>
			)}
			{note && (
				<p className="text-xs text-emerald-400" role="status">
					{note}
				</p>
			)}
			{error && (
				<p className="text-sm text-red-400" role="alert">
					{error}
				</p>
			)}
			{status?.last && (
				<p className="text-xs text-muted-foreground" data-testid="vault-link-last">
					Last run {status.last.at.replace("T", " ")}: {linkLine(status.last)}.
				</p>
			)}
		</div>
	);
}

const savedLine = (s: SavedNotes): string => `${plural(s.count, "note")} written into ${s.vault} on ${s.at}`;

/** The Obsidian notes of a course: one page per topic, reviewed here, saved into the vault on request. */
export function CourseNotes({ course }: { course: CreateCourse }) {
	const [notes, setNotes] = useState<NotesView | null>(null);
	const [vault, setVault] = useState<VaultInfo | null>(null);
	const [open, setOpen] = useState<string | null>(null);
	const [saved, setSaved] = useState<SavedNotes | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setNotes((await api<{ notes: NotesView }>(`/api/create/courses/${course.id}/notes`)).notes);
		} catch (e) {
			setError(message(e));
		}
	}, [course.id]);
	const loadVault = useCallback(async () => {
		try {
			setVault((await api<{ vault: VaultInfo }>("/api/create/vault")).vault);
		} catch (e) {
			setError(message(e));
		}
	}, []);
	useEffect(() => {
		void load();
		void loadVault();
	}, [load, loadVault]);

	const running = notes?.status === "running" || (notes?.run ?? null) !== null;
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => void load(), 1500);
		return () => clearInterval(timer);
	}, [running, load]);
	// A finished run may have made the vault's folders appear.
	const finished = useRef(running);
	useEffect(() => {
		if (finished.current && !running) void loadVault();
		finished.current = running;
	}, [running, loadVault]);

	async function post(url: string): Promise<boolean> {
		setError(null);
		try {
			const out = await api<{ started: boolean }>(url, postJson({}));
			await load();
			if (!out.started) setError("A run is going already.");
			return out.started;
		} catch (e) {
			setError(message(e));
			return false;
		}
	}
	async function setInclude(item: TopicNote, include: boolean) {
		setError(null);
		try {
			await api(`/api/create/courses/${course.id}/notes/${item.id}`, put({ include }));
			await load();
		} catch (e) {
			setError(message(e));
		}
	}
	async function saveToVault() {
		setBusy(true);
		setError(null);
		try {
			const out = await api<{ saved: SavedNotes }>(`/api/create/courses/${course.id}/notes/save`, postJson({}));
			setSaved(out.saved);
			await Promise.all([load(), loadVault()]);
		} catch (e) {
			setError(message(e));
		} finally {
			setBusy(false);
		}
	}

	const items = notes?.items ?? [];
	const chosen = items.filter((it) => it.kind === "note" && it.include).length;
	const last = saved ?? notes?.saved ?? null;
	const canWrite = course.topics.length > 0 && course.drafts > 0;
	return (
		<section className="flex flex-col gap-3 rounded-lg border bg-card p-3" data-testid="course-notes">
			<h3 className="text-sm font-medium">Obsidian notes</h3>
			<p className="text-xs text-muted-foreground">
				One page per topic, written by Claude from the cards of that topic and the pages they come from — across all PDFs of this course. You read and correct them here; nothing goes into your vault until you press “Save to Obsidian”. The notes are in English.
			</p>
			<VaultPath vault={vault} onChanged={setVault} />
			<div className="flex flex-wrap items-center gap-2">
				<Button size="sm" disabled={running || !canWrite} onClick={() => void post(`/api/create/courses/${course.id}/notes`)} data-testid="notes-write" title={canWrite ? "" : "Set the topics and sort the drafts into them first"}>
					<NotebookPenIcon /> {running ? "Writing…" : items.length > 0 ? "Write all notes again" : "Write the notes"}
				</Button>
				{!canWrite && <span className="text-xs text-muted-foreground">Set the topics and sort the drafts into them first.</span>}
				{running && notes && (
					<span className="text-xs text-muted-foreground" role="status" data-testid="notes-progress">
						{notes.run?.stage ?? "Writing"}
						{notes.run && notes.run.total > 0 ? ` — ${notes.run.done} of ${notes.run.total} topics` : "…"}
					</span>
				)}
			</div>
			{notes?.status === "error" && (
				<p className="text-sm text-red-400" role="alert" data-testid="notes-error">
					{notes.error}
				</p>
			)}
			{error && (
				<p className="text-sm text-red-400" role="alert">
					{error}
				</p>
			)}
			{items.length > 0 && (
				<ul className="flex flex-col gap-1.5" data-testid="notes-items">
					{items.map((it) => {
						const expanded = open === it.id;
						return (
							<li key={it.id} className="rounded-md border" data-testid="notes-item">
								<div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
									<input
										type="checkbox"
										className="size-4"
										checked={it.kind === "note" && it.include}
										disabled={it.kind !== "note" || running}
										onChange={(e) => void setInclude(it, e.target.checked)}
										aria-label={`Save the note ${it.topic} into Obsidian`}
										title={it.kind === "note" ? "Goes into the vault when you save" : "Not written"}
									/>
									<button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm" disabled={it.kind !== "note"} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : it.id)}>
										{it.kind === "note" ? expanded ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" /> : <span className="size-4 shrink-0" />}
										<span className="truncate">{it.topic}</span>
									</button>
									<span className={`text-xs ${it.kind === "error" ? "text-red-400" : "text-muted-foreground"}`}>{meta(it)}</span>
									{it.kind !== "pending" && (
										<Button size="xs" variant="ghost" disabled={running} onClick={() => void post(`/api/create/courses/${course.id}/notes/${it.id}`)} data-testid="note-rewrite" title="Write this note again from the cards and pages">
											<RefreshCwIcon /> Rewrite
										</Button>
									)}
								</div>
								{expanded && (
									<div className="px-3 pb-3">
										<NoteBody key={`${it.id}:${it.words}`} courseId={course.id} item={it} locked={running} onSaved={() => void load()} />
									</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{items.some((it) => it.kind === "note") && (
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" disabled={running || busy || chosen === 0 || notes?.status !== "done"} onClick={() => void saveToVault()} data-testid="notes-save">
						<SaveIcon /> {busy ? "Saving…" : `Save to Obsidian (${plural(chosen, "note")})`}
					</Button>
					{last && (
						<span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="notes-saved">
							{savedLine(last)}.
							<a href={last.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-300 hover:underline" data-testid="notes-open">
								<ExternalLinkIcon className="size-3" /> Open in Obsidian
							</a>
						</span>
					)}
				</div>
			)}
			{last?.skipped ? (
				<p className="text-xs text-amber-400" role="status">
					{plural(last.skipped, "note")} left as {last.skipped === 1 ? "it was" : "they were"}: the heading above the generated text was changed in Obsidian, so the app cannot tell where to write.
				</p>
			) : null}
			<LinkVault vault={vault} />
		</section>
	);
}
