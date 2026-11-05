"use client";

import { useCallback, useEffect, useState } from "react";
import { AudioLinesIcon, DownloadIcon, KeyRoundIcon, RefreshCwIcon, SaveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { useSettingsSaved } from "@/components/settings-signal";
import { studyApi as api, postJson } from "@/components/study/api";
import type { AudioView, CreateCourse } from "@/src/core";

const put = (body: object): RequestInit => ({ ...postJson(body), method: "PUT" });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const count = (n: number) => n.toLocaleString("en-US");
const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Which PDFs the script is written from: ticked boxes, at least one. */
function SourcePicker({ audio, picked, onChange }: { audio: AudioView; picked: ReadonlySet<string>; onChange: (next: Set<string>) => void }) {
	if (audio.sources.length === 0) return <p className="text-sm text-muted-foreground">This course has no PDFs yet — make cards from a PDF and put it into this course first.</p>;
	return (
		<ul className="flex flex-col gap-1" data-testid="audio-sources">
			{audio.sources.map((s) => (
				<li key={s.jobId}>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							className="size-4"
							checked={picked.has(s.jobId)}
							onChange={(e) => {
								const next = new Set(picked);
								if (e.target.checked) next.add(s.jobId);
								else next.delete(s.jobId);
								onChange(next);
							}}
						/>
						<span className="min-w-0 truncate">{s.name}</span>
						<span className="text-xs text-muted-foreground">{s.pages === 1 ? "1 page" : `${s.pages} pages`}</span>
					</label>
				</li>
			))}
		</ul>
	);
}

/** The voice of the summaries (ElevenLabs voice ID): shown, changed on request. */
function Voice({ audio, onChanged }: { audio: AudioView; onChanged: () => void }) {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);

	async function save(voiceId: string) {
		setError(null);
		try {
			await api("/api/create/audio/voice", put({ voiceId }));
			setEditing(false);
			onChanged();
		} catch (e) {
			setError(message(e));
		}
	}
	return (
		<div className="flex flex-col gap-1.5 text-sm" data-testid="audio-voice">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-muted-foreground">Voice:</span>
				<code className="rounded bg-muted px-1.5 py-0.5 text-xs">{audio.voiceId}</code>
				{audio.voiceId === audio.defaultVoiceId && <span className="text-xs text-muted-foreground">(the default)</span>}
				{!editing && (
					<Button size="xs" variant="ghost" onClick={() => (setText(audio.voiceId), setEditing(true))} data-testid="audio-voice-change">
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
					<Input value={text} onChange={(e) => setText(e.target.value)} className="min-w-64 flex-1" aria-label="ElevenLabs voice ID" autoComplete="off" autoFocus />
					<Button type="submit" size="sm">
						Use this voice
					</Button>
					<Button type="button" size="sm" variant="outline" onClick={() => void save("")} disabled={audio.voiceId === audio.defaultVoiceId}>
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

export interface AudioPanelProps {
	audio: AudioView;
	/** The PDFs ticked for the next script. */
	picked: ReadonlySet<string>;
	onPick: (next: Set<string>) => void;
	/** What is typed and not saved yet (null: nothing). */
	title: string | null;
	script: string | null;
	onTitle: (title: string) => void;
	onScript: (script: string) => void;
	error: string | null;
	onWrite: () => void;
	onRewrite: () => void;
	onSave: () => void;
	onGenerate: () => void;
	onVoiceChanged: () => void;
	onAddKey: () => void;
}

/** The audio summary as it looks right now (all state is the caller's). */
export function AudioPanel({ audio, picked, onPick, title, script, onTitle, onScript, error, onWrite, onRewrite, onSave, onGenerate, onVoiceChanged, onAddKey }: AudioPanelProps) {
	const running = audio.run !== null || audio.status === "running";
	const drafted = audio.status === "draft";
	const dirty = (script !== null && script !== audio.script) || (title !== null && title !== audio.title);
	const shownScript = script ?? audio.script;
	const run = audio.run;
	return (
		<section className="flex flex-col gap-3 rounded-lg border bg-card p-3" data-testid="course-audio">
			<h3 className="text-sm font-medium">Audio summary</h3>
			<p className="text-xs text-muted-foreground">
				Claude writes a spoken script from the PDFs you choose — it explains the material and teaches how to remember it. You can edit the script. Only when you press “Create audio” does ElevenLabs turn it into an MP3, and that uses ElevenLabs credit. The script is in English.
			</p>

			{!audio.keyConfigured && (
				<div className="flex flex-wrap items-center gap-2 text-sm" data-testid="audio-nokey">
					<span className="flex items-start gap-2">
						<KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
						<span>No ElevenLabs API key is saved yet — you can write the script, but not create the audio.</span>
					</span>
					<Button size="xs" variant="outline" onClick={onAddKey}>
						Add the key
					</Button>
				</div>
			)}

			{!drafted && (
				<>
					<SourcePicker audio={audio} picked={picked} onChange={onPick} />
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" disabled={running || picked.size === 0} onClick={onWrite} data-testid="audio-write">
							<AudioLinesIcon /> {running ? "Writing…" : audio.status === "error" ? "Try again" : "Write the script"}
						</Button>
						{running && run && (
							<span className="text-xs text-muted-foreground" role="status" data-testid="audio-progress">
								{run.stage}
								{run.total > 0 ? ` — ${run.done} of ${run.total} pages` : "…"}
							</span>
						)}
					</div>
					{audio.status === "error" && (
						<p className="text-sm text-red-400" role="alert" data-testid="audio-error">
							{audio.error}
						</p>
					)}
				</>
			)}

			{drafted && (
				<>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">Title</span>
						<Input value={title ?? audio.title} onChange={(e) => onTitle(e.target.value)} disabled={running} aria-label="Title of the audio summary" data-testid="audio-title" />
					</label>
					<Textarea
						value={shownScript}
						onChange={(e) => onScript(e.target.value)}
						disabled={running}
						rows={Math.min(28, Math.max(10, Math.round(shownScript.length / 90)))}
						spellCheck
						aria-label="The spoken script"
						data-testid="audio-script"
					/>
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" variant="outline" disabled={running || !dirty} onClick={onSave} data-testid="audio-save">
							<SaveIcon /> Save the script
						</Button>
						<span className="text-xs text-muted-foreground" data-testid="audio-count">
							{count(wordsOf(shownScript))} words · {count([...shownScript].length)} characters{audio.file && dirty ? " — saving drops the audio made from the old script" : ""}
						</span>
					</div>

					<Voice audio={audio} onChanged={onVoiceChanged} />

					<div className="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							disabled={running || dirty || !audio.keyConfigured}
							onClick={onGenerate}
							data-testid="audio-generate"
							title={!audio.keyConfigured ? "Add an ElevenLabs API key first" : dirty ? "Save the script first" : `Makes the MP3 through ElevenLabs — uses ElevenLabs credit (${count(audio.chars)} characters)`}
						>
							<AudioLinesIcon /> {run?.kind === "audio" ? "Creating…" : audio.file ? "Create the audio again" : "Create audio"}
						</Button>
						<span className="text-xs text-muted-foreground">Uses ElevenLabs credit — {count(audio.chars)} characters.</span>
						{run?.kind === "audio" && (
							<span className="text-xs text-muted-foreground" role="status" data-testid="audio-progress">
								{run.stage}
								{run.total > 1 ? ` — piece ${Math.min(run.done + 1, run.total)} of ${run.total}` : " — this can take a minute…"}
							</span>
						)}
					</div>
					{audio.audioError && (
						<p className="text-sm text-red-400" role="alert" data-testid="audio-error">
							{audio.audioError}
						</p>
					)}
					{audio.file && (
						<div className="flex flex-col gap-1.5" data-testid="audio-player">
							<audio key={audio.audioAt} controls preload="none" src={`/api/create/courses/${audio.courseId}/audio/file?v=${encodeURIComponent(audio.audioAt)}`} className="w-full max-w-xl" />
							<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
								<a href={`/api/create/courses/${audio.courseId}/audio/file`} download={`${audio.title || "audio-summary"}.mp3`} className="inline-flex items-center gap-1 text-sky-300 hover:underline" data-testid="audio-download">
									<DownloadIcon className="size-3" /> Download the MP3
								</a>
								{audio.audioAt && <span>made {new Date(audio.audioAt).toLocaleString()}</span>}
							</div>
						</div>
					)}

					<details className="rounded-md border px-2 py-1.5 text-sm" data-testid="audio-redo">
						<summary className="cursor-pointer text-muted-foreground">Other PDFs, or write the script again…</summary>
						<div className="mt-2 flex flex-col gap-2">
							<SourcePicker audio={audio} picked={picked} onChange={onPick} />
							<div>
								<Button size="sm" variant="outline" disabled={running || picked.size === 0} onClick={onRewrite} data-testid="audio-rewrite">
									<RefreshCwIcon /> Write the script again
								</Button>
							</div>
						</div>
					</details>
				</>
			)}

			{error && (
				<p className="text-sm text-red-400" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}

/** The audio summary of a course: a script Claude writes from the chosen PDFs, edited here, turned into an MP3 on a click. */
export function CourseAudio({ course }: { course: CreateCourse }) {
	const [audio, setAudio] = useState<AudioView | null>(null);
	const [picked, setPicked] = useState<Set<string> | null>(null);
	const [title, setTitle] = useState<string | null>(null);
	const [script, setScript] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const { open: openSettings } = useSettingsDialog();
	const base = `/api/create/courses/${course.id}/audio`;

	const load = useCallback(async () => {
		try {
			const view = (await api<{ audio: AudioView }>(base)).audio;
			setAudio(view);
			// the first look: the PDFs of the last script, else all of them
			setPicked((now) => now ?? new Set(view.jobIds.length > 0 ? view.jobIds.filter((id) => view.sources.some((s) => s.jobId === id)) : view.sources.map((s) => s.jobId)));
		} catch (e) {
			setError(message(e));
		}
	}, [base]);
	useEffect(() => {
		void load();
	}, [load]);
	// A key saved (or removed) in Settings changes what the panel offers.
	useSettingsSaved((section) => {
		if (section === "keys") void load();
	});

	const running = audio !== null && (audio.run !== null || audio.status === "running");
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => void load(), 1500);
		return () => clearInterval(timer);
	}, [running, load]);
	// A new script or a finished edit replaces what is typed.
	const stored = audio?.script ?? "";
	const storedTitle = audio?.title ?? "";
	useEffect(() => setScript(null), [stored]);
	useEffect(() => setTitle(null), [storedTitle]);

	async function send(url: string, init: RequestInit): Promise<void> {
		setError(null);
		try {
			await api(url, init);
			await load();
		} catch (e) {
			setError(message(e));
		}
	}
	if (!audio) {
		return (
			<section className="flex flex-col gap-3 rounded-lg border bg-card p-3" data-testid="course-audio">
				<h3 className="text-sm font-medium">Audio summary</h3>
				{error ? <p className="text-sm text-red-400">{error}</p> : <p className="text-xs text-muted-foreground">Loading…</p>}
			</section>
		);
	}
	const write = () => void send(`${base}/script`, postJson({ jobIds: [...(picked ?? [])] }));
	return (
		<AudioPanel
			audio={audio}
			picked={picked ?? new Set()}
			onPick={setPicked}
			title={title}
			script={script}
			onTitle={setTitle}
			onScript={setScript}
			error={error}
			onWrite={write}
			onRewrite={() => {
				if (window.confirm("The script is written again from scratch by Claude — your changes (and the audio made from the old script) are lost. Go on?")) write();
			}}
			onSave={() => void send(`${base}/script`, put({ ...(script !== null ? { script } : {}), ...(title !== null ? { title } : {}) }))}
			onGenerate={() => void send(`${base}/generate`, postJson({}))}
			onVoiceChanged={() => void load()}
			onAddKey={() => openSettings("keys", "ELEVENLABS_API_KEY")}
		/>
	);
}
