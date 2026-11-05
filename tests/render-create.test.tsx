import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DraftCard } from "../components/create/draft-card.tsx";
import { AddCardForm, CardEditor } from "../components/create/card-editor.tsx";
import { CourseDetail } from "../components/create/course-detail.tsx";
import { AudioPanel, type AudioPanelProps, CourseAudio } from "../components/create/course-audio.tsx";
import { CourseNotes } from "../components/create/course-notes.tsx";
import { NotePreview, noteBlocks } from "../components/create/note-preview.tsx";
import { CoursesPanel } from "../components/create/courses-panel.tsx";
import { DuplicatesPanel } from "../components/create/duplicates-panel.tsx";
import { LegacyImport } from "../components/create/legacy-import.tsx";
import { PagePicture } from "../components/create/page-picture.tsx";
import { NewCardsForm } from "../components/create/new-cards-form.tsx";
import { NewJobForm } from "../components/create/new-job-form.tsx";
import type { LectureSource } from "../src/core/contracts.ts";
import type { AudioView } from "../src/core/contracts/create-audio.ts";
import type { CardDraft, CreateCourse, FrontBackCard, LegendClozeCard, OcclusionCard } from "../src/core/contracts/create-cards.ts";

/**
 * The Create area's static surface (Learnbox 2.0, 2026-11): the new-job form's
 * controls and its "other PDF" choice, and the MedAnki import's dry-run-first
 * entry. Server-rendered, no network.
 */

const lecture = (id: string, title: string): LectureSource => ({
	v: 1,
	id,
	title,
	fileName: `${title}.pdf`,
	bytes: 1000,
	sha256: id,
	pages: 12,
	addedAt: "2026-11-04T10:00:00.000Z",
	status: "stored",
});

const noop = () => {};

describe("NewJobForm", () => {
	it("names the PDF and offers the settings, with English as the default language", () => {
		const html = renderToStaticMarkup(
			<NewJobForm lecture={lecture("a", "Vertebrae")} lectures={[lecture("a", "Vertebrae")]} onCreated={noop} onCancel={noop} />,
		);
		assert.match(html, /Multiple-choice test from <span[^>]*>Vertebrae<\/span>/);
		assert.match(html, /Questions per page/);
		assert.match(html, /<option value="en" selected="">English<\/option>/);
		assert.match(html, /<option value="de">German<\/option>/);
		assert.match(html, /To page \(0 = end\)/);
		assert.match(html, /Create questions/);
		assert.match(html, /Nothing is added to your cards until you adopt it/);
	});

	it("offers only OTHER library PDFs as the fact source, and none when there is no other", () => {
		const a = lecture("a", "Question sheet");
		const html = renderToStaticMarkup(<NewJobForm lecture={a} lectures={[a, lecture("b", "Lecture slides")]} onCreated={noop} onCancel={noop} />);
		assert.match(html, /<option value="b">Lecture slides<\/option>/);
		assert.doesNotMatch(html, /<option value="a">/);
		assert.match(html, /Facts from another PDF/);

		const alone = renderToStaticMarkup(<NewJobForm lecture={a} lectures={[a]} onCreated={noop} onCancel={noop} />);
		assert.doesNotMatch(alone, /Facts from another PDF/);
	});

	it("limits the page inputs to the PDF's pages", () => {
		const html = renderToStaticMarkup(<NewJobForm lecture={lecture("a", "X")} lectures={[]} onCreated={noop} onCancel={noop} />);
		assert.match(html, /max="12"/);
	});
});

describe("NewCardsForm", () => {
	it("names the PDF and offers MedAnki's card settings with English and normal as defaults", () => {
		const html = renderToStaticMarkup(<NewCardsForm lecture={lecture("a", "Cardiology")} onCreated={noop} onCancel={noop} />);
		assert.match(html, /Flashcards from <span[^>]*>Cardiology<\/span>/);
		assert.match(html, /<option value="normal" selected="">Normal<\/option>/);
		assert.match(html, /<option value="concept">Concept questions/);
		assert.match(html, /<option value="en" selected="">English<\/option>/);
		assert.match(html, /<option value="auto" selected="">Automatic \(by title\)<\/option>/);
		assert.match(html, /Atlas mode/);
		assert.match(html, /Vocabulary sheet of a language course/);
		assert.match(html, /max="12"/);
		assert.match(html, /Create cards/);
		assert.match(html, /Nothing is added to your cards until you adopt it/);
		assert.doesNotMatch(html, /Only these topics/, "the strict switch shows once there are topics");
		assert.doesNotMatch(html, /Course language/, "the course language shows with the vocabulary switch");
	});
});

describe("NewCardsForm for a course", () => {
	const courses = [
		{ id: "cardio", name: "Cardiology", topics: ["Heart failure", "Valves"], strict: true },
		{ id: "renal", name: "Renal", topics: [], strict: false },
	];

	it("offers the courses, with how many topics each has, and none by default", () => {
		const html = renderToStaticMarkup(<NewCardsForm lecture={lecture("a", "Cardiology")} courses={courses} onCreated={noop} onCancel={noop} />);
		assert.match(html, /data-testid="cards-course"/);
		assert.match(html, /<option value="" selected="">No course<\/option>/);
		assert.match(html, /<option value="cardio">Cardiology \(2 topics\)<\/option>/);
		assert.match(html, /<option value="renal">Renal<\/option>/);
	});

	it("has no course choice when there is no course yet", () => {
		const html = renderToStaticMarkup(<NewCardsForm lecture={lecture("a", "Cardiology")} onCreated={noop} onCancel={noop} />);
		assert.doesNotMatch(html, /cards-course/);
	});
});

const course = (over: Partial<CreateCourse> = {}): CreateCourse => ({ id: "cardio", name: "Cardiology", topics: [], strict: false, jobs: 0, drafts: 0, ...over });

describe("CoursesPanel", () => {
	it("says so when there is no course, and offers a new one", () => {
		const html = renderToStaticMarkup(<CoursesPanel courses={[]} onOpen={noop} onAdded={noop} />);
		assert.match(html, /data-testid="courses-empty"/);
		assert.match(html, /data-testid="course-new-name"/);
		assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="course-add"|data-testid="course-add"[^>]*disabled=""/, "nothing to add without a name");
	});

	it("lists the courses with their topics, PDFs and drafts", () => {
		const html = renderToStaticMarkup(
			<CoursesPanel
				courses={[course({ topics: ["Heart failure", "Valves"], strict: true, jobs: 2, drafts: 41, deadline: "2026-12-01" }), course({ id: "renal", name: "Renal", jobs: 1, drafts: 1 })]}
				onOpen={noop}
				onAdded={noop}
			/>,
		);
		assert.equal((html.match(/data-testid="course-row"/g) ?? []).length, 2);
		assert.match(html, /2 topics \(only these\) · 2 PDFs · 41 drafts · exam 2026-12-01/);
		assert.match(html, /No topics yet · 1 PDF · 1 draft/);
	});

	it("shows a loading note until the courses are there", () => {
		assert.match(renderToStaticMarkup(<CoursesPanel courses={null} onOpen={noop} onAdded={noop} />), /Loading…/);
	});
});

describe("CourseDetail", () => {
	it("starts with a way back, before the course is loaded", () => {
		const html = renderToStaticMarkup(<CourseDetail courseId="cardio" jobs={[]} onBack={noop} onOpenJob={noop} onChanged={noop} />);
		assert.match(html, /data-testid="course-detail"/);
		assert.match(html, /Back/);
		assert.doesNotMatch(html, /course-topics/);
	});
});

describe("CourseNotes", () => {
	it("starts with what the notes are, that nothing goes into the vault unasked, and a disabled write button until the drafts are sorted", () => {
		const html = renderToStaticMarkup(<CourseNotes course={course({ topics: ["Heart failure"], drafts: 0 })} />);
		assert.match(html, /data-testid="course-notes"/);
		assert.match(html, /Obsidian notes/);
		assert.match(html, /nothing goes into your vault until you press “Save to Obsidian”/);
		assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="notes-write"|data-testid="notes-write"[^>]*disabled=""/);
		assert.match(html, /Set the topics and sort the drafts into them first\./);
		assert.doesNotMatch(html, /notes-save/, "nothing to save before notes are written");
	});

	it("offers to write the notes once there are topics and drafts, and to link the vault", () => {
		const html = renderToStaticMarkup(<CourseNotes course={course({ topics: ["Heart failure"], drafts: 12 })} />);
		assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*data-testid="notes-write"/);
		assert.match(html, /Write the notes/);
		assert.match(html, /data-testid="vault-link"/);
		assert.match(html, /Verwandte Themen/);
		assert.match(html, /Only notes this app wrote are changed/);
	});
});

describe("CourseAudio", () => {
	const noop = () => undefined;
	const view = (extra: Partial<AudioView> = {}): AudioView => ({
		courseId: "cardio",
		status: "none",
		title: "",
		script: "",
		file: null,
		audioAt: "",
		error: "",
		audioError: "",
		jobIds: [],
		run: null,
		sources: [
			{ jobId: "crt_a", name: "01_Heart lecture", pages: 12 },
			{ jobId: "crt_b", name: "Valves", pages: 1 },
		],
		keyConfigured: true,
		voiceId: "21m00Tcm4TlvDq8ikWAM",
		defaultVoiceId: "21m00Tcm4TlvDq8ikWAM",
		chars: 0,
		...extra,
	});
	/** The markup without React's text-node separators, so a sentence reads as one. */
	const panel = (audio: AudioView, extra: Partial<AudioPanelProps> = {}) =>
		renderToStaticMarkup(
			<AudioPanel audio={audio} picked={new Set(["crt_a"])} onPick={noop} title={null} script={null} onTitle={noop} onScript={noop} error={null} onWrite={noop} onRewrite={noop} onSave={noop} onGenerate={noop} onVoiceChanged={noop} onAddKey={noop} {...extra} />,
		).replace(/<!-- -->/g, "");

	it("starts by loading", () => {
		const html = renderToStaticMarkup(<CourseAudio course={course()} />);
		assert.match(html, /data-testid="course-audio"/);
		assert.match(html, /Audio summary/);
		assert.match(html, /Loading…/);
	});

	it("before a script: says what it is, lists the PDFs with the ticked ones, and offers to write the script", () => {
		const html = panel(view());
		assert.match(html, /that uses ElevenLabs credit/);
		assert.match(html, /01_Heart lecture/);
		assert.match(html, /12 pages/);
		assert.match(html, /1 page</);
		assert.match(html, /<input[^>]*checked=""[^>]*\/>/, "the ticked PDF");
		assert.match(html, /Write the script/);
		assert.doesNotMatch(html, /audio-generate|audio-script/, "no audio before a script");
	});

	it("will not write a script from no PDF, and asks for the key without hiding the script", () => {
		assert.match(panel(view(), { picked: new Set() }), /<button[^>]*disabled=""[^>]*data-testid="audio-write"|data-testid="audio-write"[^>]*disabled=""/);
		assert.match(panel(view({ sources: [] })), /has no PDFs yet/);
		assert.match(panel(view({ keyConfigured: false })), /data-testid="audio-nokey"[\s\S]*No ElevenLabs API key is saved yet/);
		assert.doesNotMatch(panel(view({ keyConfigured: true })), /audio-nokey/);
	});

	it("shows how far a run is, and a failed script", () => {
		const running = panel(view({ status: "running", run: { kind: "script", stage: "Reading the pages", done: 3, total: 12 } }));
		assert.match(running, /Reading the pages — 3 of 12 pages/);
		assert.match(running, /Writing…/);
		assert.match(panel(view({ status: "error", error: "Claude gave no script." })), /role="alert"[^>]*>Claude gave no script\./);
		assert.match(panel(view({ status: "error", error: "Claude gave no script." })), /Try again/);
	});

	it("a script: editable, counted, with the voice; the audio needs a saved script and a key", () => {
		const draft = view({ status: "draft", title: "The heart", script: "First the atria fill. Then the ventricles contract.", chars: 49, jobIds: ["crt_a"] });
		const html = panel(draft);
		assert.match(html, /data-testid="audio-script"/);
		assert.match(html, /The heart/);
		assert.match(html, /8 words · 51 characters/);
		assert.match(html, /Uses ElevenLabs credit — 49 characters/);
		assert.match(html, /\(the default\)/);
		assert.match(html, /Create audio/);
		assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*data-testid="audio-generate"/);
		assert.doesNotMatch(html, /audio-player/, "nothing to play yet");
		assert.match(panel(draft, { script: "Changed." }), /data-testid="audio-generate"[^>]*disabled=""|<button[^>]*disabled=""[^>]*data-testid="audio-generate"/, "save first");
		assert.match(panel({ ...draft, keyConfigured: false }), /<button[^>]*disabled=""[^>]*data-testid="audio-generate"|data-testid="audio-generate"[^>]*disabled=""/);
	});

	it("an audio: a player that reloads for a new file, a download, and a failed attempt shown", () => {
		const done = view({ status: "draft", title: "The heart", script: "One.", chars: 4, file: "summary.mp3", audioAt: "2026-11-05T10:00:00.000Z" });
		const html = panel(done);
		assert.match(html, /<audio[^>]*src="\/api\/create\/courses\/cardio\/audio\/file\?v=2026-11-05T10%3A00%3A00\.000Z"/);
		assert.match(html, /Download the MP3/);
		assert.match(html, /Create the audio again/);
		assert.match(panel({ ...done, audioError: "ElevenLabs rejects the API key (401)" }), /role="alert"[^>]*>ElevenLabs rejects the API key \(401\)/);
		const making = panel({ ...done, run: { kind: "audio", stage: "Creating the audio", done: 1, total: 3 } });
		assert.match(making, /Creating the audio — piece 2 of 3/);
		assert.match(panel({ ...done, run: { kind: "audio", stage: "Creating the audio", done: 0, total: 1 } }), /this can take a minute/);
	});
});

describe("NotePreview", () => {
	const note = [
		"[[Cardiology/Themen/00 Übersicht|↑ Cardiology · Themen]]",
		"",
		"> [!abstract] Kernaussagen",
		"> - Heart failure is **common** ([[Lecture.pdf#page=3|Lecture · S. 3]])",
		"",
		"## Details",
		"- First *point*",
		"- Second point",
		"",
		"![[Heart-failure_D1_p003_F1.png|560]]",
		"*Abb.: The failing heart* [[Lecture.pdf#page=3|Lecture · S. 3]]",
		"",
		"<script>alert(1)</script>",
	].join("\n");

	it("reads the note into boxes, headings, lists, pictures and paragraphs", () => {
		assert.deepEqual(
			noteBlocks(note).map((b) => b.kind),
			["text", "callout", "heading", "list", "figure", "text", "text"],
		);
		const callout = noteBlocks(note)[1]!;
		assert.ok(callout.kind === "callout" && callout.title === "Kernaussagen" && callout.items.length === 1);
	});

	it("draws bold, italic and page links as their label, and the picture from the note set", () => {
		const html = renderToStaticMarkup(<NotePreview markdown={note} figureUrl={(f) => `/media/${f}`} />);
		assert.match(html, /<b>common<\/b>/);
		assert.match(html, /<i>point<\/i>/);
		assert.match(html, /<span[^>]*>Lecture · S\. 3<\/span>/);
		assert.match(html, /<img src="\/media\/Heart-failure_D1_p003_F1\.png"/);
		assert.match(html, /Kernaussagen/);
	});

	it("draws a Markdown table as a table", () => {
		const table = ["| Type | Ribs |", "|---|---|", "| Costae verae | I–VII |", "| **Costae spuriae** | VIII–X |"].join("\n");
		const [block] = noteBlocks(table);
		assert.ok(block?.kind === "table" && block.head.join() === "Type,Ribs" && block.rows.length === 2);
		const html = renderToStaticMarkup(<NotePreview markdown={table} figureUrl={(f) => f} />);
		assert.match(html, /<th[^>]*>Type<\/th>/);
		assert.match(html, /<td[^>]*><b>Costae spuriae<\/b><\/td>/);
		assert.doesNotMatch(html, /\|---\|/);
	});

	it("never injects the note's text as HTML", () => {
		const html = renderToStaticMarkup(<NotePreview markdown={note} figureUrl={(f) => f} />);
		assert.doesNotMatch(html, /<script>/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	});
});

describe("DuplicatesPanel across a course", () => {
	it("names the scope in its title", () => {
		const html = renderToStaticMarkup(<DuplicatesPanel scope={{ courseId: "cardio" }} onChanged={noop} />);
		assert.match(html, /Duplicate cards across the PDFs of this course/);
		assert.match(html, /data-testid="dedupe-check"/);
	});
});

const base = { page: 3, tier: 2 as const, whyType: "", extra: "", evidence: "", tags: [], warnings: [], deleted: false, include: true, manual: false, sourceIds: [], sourceBbox: null, image: null };
const media = (file: string) => `/m/${file}`;
const draft = (c: CardDraft) => renderToStaticMarkup(<DraftCard c={c} mediaUrl={media} selected onSelect={noop} onToggleDeleted={noop} />);

describe("DraftCard", () => {
	it("shows a question with its answer, bold and the Latin term's English addition, and the warnings", () => {
		const c: FrontBackCard = { ...base, id: "p003-c01", type: "basic", front: "Which nerve runs through the **carpal tunnel**?", back: "N. medianus [[en:median nerve]]", extra: "Compressed in carpal tunnel syndrome", warnings: ["Question is very long"] };
		const html = draft(c);
		assert.match(html, /Which nerve runs through the <b>carpal tunnel<\/b>\?/);
		assert.match(html, /N\. medianus <span[^>]*> \(median nerve\)<\/span>/);
		assert.match(html, /Compressed in carpal tunnel syndrome/);
		assert.match(html, /Question is very long/);
		assert.match(html, /Add this card to my cards/);
		assert.match(html, /Core|Good to know/);
	});

	it("never injects card text as HTML", () => {
		const c: FrontBackCard = { ...base, id: "p003-c01", type: "basic", front: "<img src=x onerror=alert(1)>", back: "<script>1</script>" };
		const html = draft(c);
		assert.doesNotMatch(html, /<img src=x/);
		assert.doesNotMatch(html, /<script>/);
		assert.match(html, /&lt;script&gt;/);
	});

	it("marks the gaps of a gap text and shows the figure", () => {
		const c: LegendClozeCard = { ...base, id: "p003-c02", type: "cloze", text: "1 {{c1::Aorta}}\n2 {{c2::Vena cava}}", legendCloze: true, markerBoxes: {}, markerNums: {}, image: { bbox: [0, 0, 1, 1], where: "front", file: "img_a.png" } };
		const html = draft(c);
		assert.match(html, /title="Gap 1"/);
		assert.match(html, /title="Gap 2"/);
		assert.match(html, /src="\/m\/img_a\.png"/);
		assert.doesNotMatch(html, /\{\{c1/);
	});

	it("shows both pictures of an occlusion card and says when the covered place is a guess", () => {
		const c = { ...base, id: "p003-c03", type: "image_occlusion", header: "Name the structure", mode: "one", figureBbox: [0, 0, 1, 1], figureExact: false, maskExact: false, label: "Aorta", hint: "", boxes: [], markerBbox: null, allBoxes: [], needsCheck: true, questionFile: "q.png", answerFile: "a.png" } as OcclusionCard;
		const html = draft(c);
		assert.match(html, /Name the structure/);
		assert.match(html, /Aorta/);
		assert.match(html, /src="\/m\/q\.png"/);
		assert.match(html, /src="\/m\/a\.png"/);
		assert.match(html, /The covered place is a guess/);
	});

	it("strikes a deleted card through with its reason and offers to bring it back; an adopted one is only labelled", () => {
		const gone: FrontBackCard = { ...base, id: "p003-c01", type: "basic", front: "Q", back: "A", deleted: true, note: "Duplicate of p001-c02" };
		const html = draft(gone);
		assert.match(html, /line-through/);
		assert.match(html, /Duplicate of p001-c02/);
		assert.match(html, /aria-label="Bring back"/);
		assert.doesNotMatch(html, /type="checkbox"/);

		const adopted: FrontBackCard = { ...base, id: "p003-c02", type: "basic", front: "Q", back: "A", adopted: { courseId: "c", cardId: "x", at: "2026-11-04T10:00:00.000Z" } };
		const done = draft(adopted);
		assert.match(done, /In your cards/);
		assert.doesNotMatch(done, /aria-label="Throw away"/);
	});
});

describe("DraftCard on the focus screen", () => {
	it("shows the number of the card, marks the active one and holds the tools under the text", () => {
		const c: FrontBackCard = { ...base, id: "p003-c01", type: "basic", front: "Q", back: "A", edited: true };
		const html = renderToStaticMarkup(
			<DraftCard c={c} mediaUrl={media} selected={false} onSelect={noop} onToggleDeleted={noop} number={4} active>
				<button>Move mask</button>
			</DraftCard>,
		);
		assert.match(html, /bg-sky-500\/80[^>]*>4<\/span>/);
		assert.match(html, /border-sky-400\/70/);
		assert.match(html, /<button>Move mask<\/button>/);
		assert.match(html, /Edited/);
		assert.match(html, /id="draft-p003-c01"/);
		assert.doesNotMatch(html, /checked=""/);
	});
});

describe("PagePicture", () => {
	const markers = [
		{ id: "p003-c01", box: [0.1, 0.2, 0.3, 0.4] as [number, number, number, number], label: "1", kind: "source" as const },
		{ id: "p003-c02", box: [0.5, 0.5, 0.6, 0.55] as [number, number, number, number], label: "2", kind: "mask" as const, active: true },
	];

	it("lays the numbered boxes of the cards over the page in percent", () => {
		const html = renderToStaticMarkup(<PagePicture src="/p.png" alt="Page 3" markers={markers} onMarker={noop} />);
		assert.match(html, /src="\/p\.png"/);
		assert.match(html, /left:10(\.0+)?%;top:20(\.0+)?%;width:20(\.0+)?%;height:20(\.0+)?%/);
		assert.match(html, /aria-label="Card 2"/);
		assert.match(html, /border-orange-400/);
		assert.doesNotMatch(html, /page-tool-/, "no tool, no drawing layer");
	});

	it("offers eight handles and the body to drag when a box is edited, and a plain layer when one is drawn", () => {
		const edit = renderToStaticMarkup(<PagePicture src="/p.png" alt="" markers={[]} onMarker={noop} tool={{ mode: "edit", box: [0.2, 0.2, 0.4, 0.4], onEdit: noop }} />);
		assert.match(edit, /data-testid="page-tool-edit"/);
		assert.equal((edit.match(/data-handle=/g) ?? []).length, 9);
		assert.match(edit, /data-handle="move"/);
		const draw = renderToStaticMarkup(<PagePicture src="/p.png" alt="" markers={[]} onMarker={noop} tool={{ mode: "draw", onDraw: noop }} />);
		assert.match(draw, /data-testid="page-tool-draw"/);
		assert.doesNotMatch(draw, /data-handle=/);
	});
});

describe("CardEditor and AddCardForm", () => {
	it("edits the sides of a question, the gap text of a cloze, or the header and answer of a picture card", () => {
		const qa: FrontBackCard = { ...base, id: "p003-c01", type: "basic", front: "Which nerve?", back: "Median nerve", tags: ["arm", "nerve"] };
		const html = renderToStaticMarkup(<CardEditor c={qa} onSave={async () => undefined} onCancel={noop} />);
		assert.match(html, /Question[\s\S]*Which nerve\?/);
		assert.match(html, /Median nerve/);
		assert.match(html, /value="arm, nerve"/);
		assert.match(html, /<option value="2" selected="">Good to know<\/option>/);

		const gap: LegendClozeCard = { ...base, id: "p003-c02", type: "cloze", text: "1 {{c1::Aorta}}", legendCloze: true, markerBoxes: {}, markerNums: {} };
		assert.match(renderToStaticMarkup(<CardEditor c={gap} onSave={async () => undefined} onCancel={noop} />), /Gap text — gaps as/);

		const pic = { ...base, id: "p003-c03", type: "image_occlusion", header: "Name it", label: "Aorta", mode: "one", figureBbox: [0, 0, 1, 1], figureExact: false, maskExact: false, hint: "", boxes: [], markerBbox: null, allBoxes: [], needsCheck: false, questionFile: null, answerFile: null } as OcclusionCard;
		const html3 = renderToStaticMarkup(<CardEditor c={pic} onSave={async () => undefined} onCancel={noop} />);
		assert.match(html3, /Question above the picture/);
		assert.match(html3, /Answer \(the covered word\)/);
	});

	it("starts as a question card and offers the picture card with its two region buttons", () => {
		const html = renderToStaticMarkup(<AddCardForm onPick={noop} picking={false} onSubmit={async () => undefined} />);
		assert.match(html, /<option value="basic" selected="">Question and answer<\/option>/);
		assert.match(html, /<option value="image_occlusion">Cover a part of the picture<\/option>/);
		assert.match(html, /data-testid="add-card-submit"/);
		assert.doesNotMatch(html, /pick-area/, "the area buttons show with the picture type");
	});
});

describe("DuplicatesPanel", () => {
	it("starts with the strictness choice and Claude's check, before anything is loaded", () => {
		const html = renderToStaticMarkup(<DuplicatesPanel scope={{ jobId: "crt_x" }} onChanged={noop} />);
		assert.match(html, /Duplicate cards/);
		assert.match(html, /<option value="0\.8" selected="">Normal<\/option>/);
		assert.match(html, /data-testid="dedupe-check"/);
		assert.doesNotMatch(html, /dup-group/);
	});
});

describe("LegacyImport", () => {
	it("starts closed and does nothing until Check is pressed", () => {
		const html = renderToStaticMarkup(<LegacyImport onImported={noop} />);
		assert.match(html, /<details[^>]*data-testid="legacy-import"/);
		assert.doesNotMatch(html, /<details[^>]* open/);
		assert.match(html, /MedAnki itself is not changed/);
		assert.match(html, /data-testid="legacy-check"/);
		assert.doesNotMatch(html, /legacy-import-button/);
		assert.doesNotMatch(html, /legacy-jobs/);
	});
});
