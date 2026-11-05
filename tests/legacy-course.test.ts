/**
 * MedAnki's subjects, topic notes, audio summary and settings in Learnbox's shapes (src/core/legacy-course.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	legacyAudio,
	legacyCourseRecord,
	legacyCourses,
	legacyFigureFiles,
	legacyJobId,
	legacyLinkResult,
	legacyNotes,
	legacyVaultPath,
	legacyVoice,
} from "../src/core/legacy-course.ts";

describe("subjects", () => {
	const settings = {
		courses: [
			{ id: "fac3b82a0", name: "Anatomy", topics: ["Terminology", "Vertebra", "vertebra"], strict: true },
			{ id: "f2588fd6f", name: "  Basics   of IT ", topics: [], strict: true },
			{ id: "bad id", name: "No" },
			{ id: "fac3b82a0", name: "Again" },
			{ id: "nameless", name: "" },
			"junk",
		],
	};

	it("reads the subjects: a clean name, de-duplicated topics, 'only these topics' only with topics", () => {
		assert.deepEqual(legacyCourses(settings), [
			{ id: "fac3b82a0", name: "Anatomy", topics: ["Terminology", "Vertebra"], strict: true },
			{ id: "f2588fd6f", name: "Basics of IT", topics: [], strict: false },
		]);
		assert.deepEqual(legacyCourses(null), []);
		assert.deepEqual(legacyCourses({ courses: "x" }), []);
	});

	it("a subject becomes a course of the same id; that id is its vault key, and there is no deadline", () => {
		const [anatomy, it2] = legacyCourses(settings);
		assert.deepEqual(legacyCourseRecord(anatomy!, "Anatomy", "2026-11-05T10:00:00.000Z"), {
			id: "fac3b82a0",
			name: "Anatomy",
			bufferDays: 5,
			topics: ["Terminology", "Vertebra"],
			strictTopics: true,
			vaultKey: "fac3b82a0",
			createdAt: "2026-11-05T10:00:00.000Z",
		});
		const bare = legacyCourseRecord(it2!, "Basics of IT (MedAnki)", "t");
		assert.equal(bare.name, "Basics of IT (MedAnki)");
		assert.equal("topics" in bare, false);
		assert.equal("strictTopics" in bare, false);
		assert.equal("deadline" in bare, false);
	});

	it("a MedAnki job's id gives the Learnbox job's id", () => {
		assert.equal(legacyJobId("20261104-173330-e676"), "crt_legacy_20261104-173330-e676");
	});
});

describe("settings", () => {
	it("the vault folder must be absolute", () => {
		assert.equal(legacyVaultPath({ vault_path: "/Users/x/Vault" }), "/Users/x/Vault");
		assert.equal(legacyVaultPath({ vault_path: "relative/dir" }), null);
		assert.equal(legacyVaultPath({ vault_path: "" }), null);
		assert.equal(legacyVaultPath(null), null);
	});
	it("the voice is an ID or nothing", () => {
		assert.equal(legacyVoice({ elevenlabs_voice_id: "21m00Tcm4TlvDq8ikWAM" }), "21m00Tcm4TlvDq8ikWAM");
		assert.equal(legacyVoice({ elevenlabs_voice_id: "not valid!" }), null);
		assert.equal(legacyVoice({}), null);
	});
	it("the last linking result: snake_case becomes camelCase", () => {
		assert.deepEqual(
			legacyLinkResult({ link_result: { notes: 14, own: 14, linked: 13, links: 17, written: 13, removed: 0, llm: true, llm_failed: 2, colors: false, at: "2026-10-09T12:01:25" } }),
			{ notes: 14, own: 14, linked: 13, links: 17, written: 13, removed: 0, llm: true, llmFailed: 2, colors: false, at: "2026-10-09T12:01:25" },
		);
		assert.equal(legacyLinkResult({}), null);
		assert.equal(legacyLinkResult({ link_result: { notes: 1 } }), null);
	});
});

describe("topic notes", () => {
	const raw = {
		status: "done",
		error: "",
		name: "Biophysics",
		created: "2026-10-20",
		sources: [
			{ ref: "D1", job_id: "20261006-104914-6fda", name: "02a_Acoustics", pdf_file: "02a_Acoustics.pdf" },
			{ ref: "D2" },
		],
		items: [
			{
				id: "t01",
				ix: "1",
				topic: "Acoustics",
				kind: "note",
				skip_reason: "",
				cards: "137",
				pages: 28,
				refs: ["D1"],
				markdown: "> [!abstract] Kernaussagen\n> - **Acoustics**",
				words: "1205",
				figures: [{ id: "D1_p027_F1", file: "Acoustics_D1_p027_F1.png", src: "figs/D1_p027_F1.png", page: 27, ref: "D1", caption: "A scale" }, { id: "" }],
				include: true,
				error: "",
				tags: ["acoustics"],
			},
			{ topic: "Viscosity", kind: "skipped", skip_reason: "nothing", include: false },
			{ kind: "note" },
		],
		saved: { path: "/v/Biophysics/Themen/00 Übersicht.md", url: "obsidian://x", created: false, vault: "/v", count: 7, at: "2026-10-20" },
	};
	const ids = (id: string) => `crt_legacy_${id}`;

	it("the note set: numbers read from MedAnki's text, the sources point at the new job ids, the save stays", () => {
		const doc = legacyNotes(raw, ids)!;
		assert.equal(doc.status, "done");
		assert.equal(doc.name, "Biophysics");
		assert.deepEqual(doc.sources, [{ ref: "D1", jobId: "crt_legacy_20261006-104914-6fda", name: "02a_Acoustics", pdfFile: "02a_Acoustics.pdf" }]);
		assert.equal(doc.items.length, 2, "a note without a topic is left out");
		const [a, b] = doc.items;
		assert.deepEqual({ id: a!.id, ix: a!.ix, kind: a!.kind, cards: a!.cards, pages: a!.pages, words: a!.words, refs: a!.refs, include: a!.include, tags: a!.tags }, { id: "t01", ix: 1, kind: "note", cards: 137, pages: 28, words: 1205, refs: ["D1"], include: true, tags: ["acoustics"] });
		assert.equal(a!.figures.length, 1);
		assert.deepEqual(a!.figures[0], { id: "D1_p027_F1", file: "Acoustics_D1_p027_F1.png", src: "figs/D1_p027_F1.png", page: 27, ref: "D1", caption: "A scale" });
		assert.equal(b!.kind, "skipped");
		assert.equal(b!.skipReason, "nothing");
		assert.equal(b!.include, false);
		assert.equal(b!.id, "t02", "a missing id is numbered in order");
		assert.equal(doc.saved?.path, "/v/Biophysics/Themen/00 Übersicht.md");
		assert.equal(doc.saved?.count, 7);
		assert.equal(doc.saved?.at, "2026-10-20");
	});

	it("a note set that was cut off counts as done with what it has; an error stays an error; no notes: nothing", () => {
		assert.equal(legacyNotes({ ...raw, status: "running" }, ids)!.status, "done");
		assert.equal(legacyNotes({ ...raw, status: "error", error: "boom" }, ids)!.status, "error");
		assert.equal(legacyNotes({ ...raw, items: [] }, ids), null);
		assert.equal(legacyNotes(null, ids), null);
		assert.equal(legacyNotes({ ...raw, saved: null }, ids)!.saved, null);
	});

	it("the figure files a note set needs: plain names only", () => {
		const doc = legacyNotes({ ...raw, items: [{ topic: "T", figures: [{ id: "a", file: "a.png" }, { id: "b", file: "../secret.png" }, { id: "c", file: "sub/c.png" }, { id: "d", file: "a.png" }] }] }, ids)!;
		assert.deepEqual(legacyFigureFiles(doc), ["a.png"]);
	});
});

describe("audio summary", () => {
	const raw = { status: "done", title: "Biophysics Labs", script: "Hello.", file: "summary.mp3", error: "", job_ids: ["a", "b"] };
	const ids = (id: string) => `crt_legacy_${id}`;

	it("a script with its MP3: a draft that knows when the audio was made", () => {
		assert.deepEqual(legacyAudio(raw, ids, { file: "summary.mp3", at: "2026-10-20T09:00:00.000Z" }), {
			status: "draft",
			title: "Biophysics Labs",
			script: "Hello.",
			file: "summary.mp3",
			audioAt: "2026-10-20T09:00:00.000Z",
			error: "",
			audioError: "",
			jobIds: ["crt_legacy_a", "crt_legacy_b"],
		});
	});
	it("without the MP3 file there is no audio, only the script", () => {
		const doc = legacyAudio(raw, ids, { file: null, at: "" })!;
		assert.equal(doc.file, null);
		assert.equal(doc.audioAt, "");
		assert.equal(doc.status, "draft");
	});
	it("no script: nothing to carry over", () => {
		assert.equal(legacyAudio({ ...raw, script: "  " }, ids, { file: null, at: "" }), null);
		assert.equal(legacyAudio(null, ids, { file: null, at: "" }), null);
	});
});
