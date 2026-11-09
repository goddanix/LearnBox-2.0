import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	LecturesBody,
	clearLecture,
	countPick,
	formatPages,
	pickRequest,
	prunePick,
	setDepth,
	statusLine,
	toggleLecture,
	toggleTopic,
	type LecturePick,
} from "../components/lectures-dialog.tsx";
import { LectureContextCard } from "../components/lecture-context-card.tsx";
import { LecturePickerControl } from "../components/composer-actions.tsx";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";
import type { LectureContextData, LectureSource } from "../src/core/contracts.ts";

/**
 * The lecture flow's UI seams (Learnbox, 2026-10): the pick's pure state
 * helpers, the request body they produce, the dialog's visible surface per
 * lecture status, the composer pill, the chat card, and the create-session
 * contract carrying `lectureContext`. All server-rendered, no network.
 */

const TOPICS = [
	{ id: "t1", title: "Ion gradients", summary: "Concentration differences drive ion flow.", pageStart: 3, pageEnd: 6 },
	{ id: "t2", title: "Nernst equation", summary: "Equilibrium potential of one ion.", pageStart: 7, pageEnd: 9 },
];

function source(over: Partial<LectureSource> = {}): LectureSource {
	return {
		v: 1,
		id: "lec_1",
		title: "Membranes",
		fileName: "Membranes.pdf",
		bytes: 1000,
		sha256: "x",
		pages: 40,
		addedAt: "2026-10-27T10:00:00.000Z",
		status: "ready",
		outline: { topics: TOPICS, generatedAt: "2026-10-27T10:05:00.000Z" },
		...over,
	};
}

const noop = () => {};
function body(sources: LectureSource[], pick: LecturePick = {}, extra: { errors?: string[]; uploading?: boolean } = {}) {
	return renderToStaticMarkup(
		<LecturesBody
			sources={sources}
			pick={pick}
			errors={extra.errors ?? []}
			uploading={extra.uploading ?? false}
			onUpload={noop}
			onOutline={noop}
			onRemove={noop}
			onPick={noop}
			onClose={noop}
		/>,
	);
}

describe("the lecture pick", () => {
	it("toggles a topic on with the default depth and off again, dropping an emptied lecture", () => {
		const on = toggleTopic({}, "lec_1", "t1");
		assert.deepEqual(on, { lec_1: { t1: "mechanism" } });
		assert.deepEqual(toggleTopic(on, "lec_1", "t1"), {});
	});

	it("sets a depth without touching the other topics, and never mutates its input", () => {
		const start: LecturePick = { lec_1: { t1: "mechanism", t2: "overview" } };
		const next = setDepth(start, "lec_1", "t1", "derivation");
		assert.deepEqual(next, { lec_1: { t1: "derivation", t2: "overview" } });
		assert.deepEqual(start, { lec_1: { t1: "mechanism", t2: "overview" } });
	});

	it("'All' picks every topic and keeps depths already chosen; 'None' clears the lecture", () => {
		const all = toggleLecture({ lec_1: { t2: "derivation" } }, source());
		assert.deepEqual(all, { lec_1: { t1: "mechanism", t2: "derivation" } });
		assert.deepEqual(toggleLecture(all, source()), {});
		assert.deepEqual(toggleLecture({}, source({ outline: undefined, status: "stored" })), {}, "nothing to pick without an outline");
	});

	it("counts topics and lectures, and builds the request from ids and depths only", () => {
		const pick: LecturePick = { lec_1: { t1: "overview", t2: "derivation" }, lec_2: { t9: "mechanism" }, lec_3: {} };
		assert.deepEqual(countPick(pick), { topics: 3, lectures: 2 });
		assert.deepEqual(pickRequest(pick), {
			lectures: [
				{ id: "lec_1", topics: [{ id: "t1", depth: "overview" }, { id: "t2", depth: "derivation" }] },
				{ id: "lec_2", topics: [{ id: "t9", depth: "mechanism" }] },
			],
		});
		assert.deepEqual(pickRequest({}), { lectures: [] });
	});

	it("prunes picks of removed lectures and of topics an outline no longer has", () => {
		const pick: LecturePick = { lec_1: { t1: "overview", t7: "mechanism" }, lec_gone: { t1: "overview" } };
		assert.deepEqual(prunePick(pick, [source()]), { lec_1: { t1: "overview" } });
		assert.deepEqual(prunePick(pick, []), {});
	});
});

describe("the lectures dialog", () => {
	it("shows the empty state and the nothing-picked line", () => {
		const html = body([]);
		assert.match(html, /data-testid="lectures-dialog"/);
		assert.match(html, /No lectures yet\./);
		assert.match(html, /Nothing picked: the session starts without lectures\./);
		assert.doesNotMatch(html, /data-testid="lectures-clear"/);
	});

	it("a stored lecture offers 'Create outline' and no topics", () => {
		const html = body([source({ status: "stored", outline: undefined })]);
		assert.match(html, /data-testid="lecture-outline-lec_1"[^>]*>Create outline</);
		assert.match(html, /40 pages · no outline yet/);
		assert.doesNotMatch(html, /Ion gradients/);
	});

	it("an outlining lecture shows progress and cannot be removed", () => {
		const html = body([source({ status: "outlining", outline: undefined, progress: { done: 2, total: 5 } })]);
		assert.match(html, /outlining… 2\/5/);
		assert.doesNotMatch(html, /lecture-remove-lec_1/);
		assert.doesNotMatch(html, /lecture-outline-lec_1/);
	});

	it("a failed lecture shows the reason and 'Try again'", () => {
		const html = body([source({ status: "failed", outline: undefined, error: "No model configured — set up your models first" })]);
		assert.match(html, /role="alert"[^>]*>No model configured/);
		assert.match(html, /data-testid="lecture-outline-lec_1"[^>]*>Try again</);
	});

	it("a ready lecture with picks is open: topics with pages, a depth control for picked ones only, counts", () => {
		const html = body([source()], { lec_1: { t2: "derivation" } });
		assert.match(html, /40 pages · 2 topics · 1 picked/);
		assert.match(html, /Ion gradients/);
		assert.match(html, /pp\. 7-9/);
		assert.match(html, /Equilibrium potential of one ion\./);
		assert.match(html, /aria-checked="true" aria-label="Pick Nernst equation"/);
		assert.match(html, /aria-checked="false" aria-label="Pick Ion gradients"/);
		assert.match(html, /data-testid="depth-lec_1-t2-derivation"/);
		assert.doesNotMatch(html, /data-testid="depth-lec_1-t1-/, "an unpicked topic has no depth control");
		assert.match(html, /1 topic from 1 lecture picked/);
		assert.match(html, /data-testid="lectures-clear"/);
	});

	it("only a ready lecture offers 'Re-create outline'", () => {
		assert.match(body([source()]), /data-testid="lecture-recreate-lec_1"[^>]*>Re-create outline</);
		assert.doesNotMatch(body([source({ status: "stored", outline: undefined })]), /lecture-recreate-/);
		assert.doesNotMatch(body([source({ status: "failed", outline: undefined, error: "x" })]), /lecture-recreate-/);
		assert.doesNotMatch(body([source({ status: "outlining", progress: { done: 1, total: 3 } })]), /lecture-recreate-/);
	});

	it("a ready lecture shows a failed re-run's note while keeping its topics", () => {
		const html = body([source({ error: "Re-creating the outline failed; the previous outline is kept. No model configured" })], { lec_1: { t1: "mechanism" } });
		assert.match(html, /role="alert"[^>]*>Re-creating the outline failed; the previous outline is kept/);
		assert.match(html, /Ion gradients/);
	});

	it("clearing one lecture leaves the others alone", () => {
		const pick: LecturePick = { lec_1: { t1: "overview" }, lec_2: { t3: "derivation" } };
		assert.deepEqual(clearLecture(pick, "lec_1"), { lec_2: { t3: "derivation" } });
		assert.deepEqual(clearLecture(pick, "lec_9"), pick);
	});

	it("warns about pages without readable text", () => {
		const outline = { topics: TOPICS, generatedAt: "x", thinPages: [2, 11] };
		const html = body([source({ outline })], { lec_1: { t1: "mechanism" } });
		assert.match(html, /Pages 2, 11 had no readable text/);
	});

	it("renders upload errors as alerts and a busy upload state", () => {
		const html = body([], {}, { errors: ["notes.txt: only PDF files can be added."], uploading: true });
		assert.match(html, /role="alert"[^>]*>notes\.txt: only PDF files can be added\./);
		assert.match(html, /Adding…/);
	});

	it("formats status lines and long page lists", () => {
		assert.equal(statusLine(source({ pages: 1 }), 0), "1 page · 2 topics");
		assert.equal(statusLine(source({ pages: null, status: "stored", outline: undefined }), 0), "no outline yet");
		assert.equal(formatPages([1, 2, 3]), "1, 2, 3");
		assert.equal(formatPages([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), "1, 2, 3, 4, 5, 6, 7, 8 and 2 more");
	});
});

describe("the composer pill and the chat card", () => {
	it("the pill reads 'Add lectures' empty, and the topic count with Clear once picked", () => {
		const empty = renderToStaticMarkup(<LecturePickerControl topics={0} />);
		assert.match(empty, /Add lectures/);
		assert.doesNotMatch(empty, /lectures-chip-clear/);
		const one = renderToStaticMarkup(<LecturePickerControl topics={1} />);
		assert.match(one, /1 lecture topic</);
		const many = renderToStaticMarkup(<LecturePickerControl topics={4} />);
		assert.match(many, /4 lecture topics/);
		assert.match(many, /data-testid="lectures-chip-clear"/);
	});

	it("the draft shows the pill only for teach, never for practice", () => {
		const pill = <LecturePickerControl topics={0} />;
		const shell = (mode: "teach" | "practice") =>
			renderToStaticMarkup(<DraftShell busy={false} text="" onChange={noop} onSend={noop} mode={mode} lecturePicker={pill} />);
		assert.match(shell("teach"), /data-testid="lectures-chip"/);
		assert.doesNotMatch(shell("practice"), /data-testid="lectures-chip"/);
	});

	it("the card is collapsed with a count, and carries no file path", () => {
		const data: LectureContextData = {
			lectures: [{ id: "lec_1", title: "Membranes", fileName: "Membranes.pdf", pages: 40, topics: [{ ...TOPICS[0]!, depth: "overview" }, { ...TOPICS[1]!, depth: "derivation" }] }],
		};
		const html = renderToStaticMarkup(<LectureContextCard data={data} />);
		assert.match(html, /data-testid="lecture-context-card"/);
		assert.match(html, /2 topics · 1 lecture/);
		assert.doesNotMatch(html, /lecture-context-body/, "collapsed by default");
		assert.doesNotMatch(html, /source\.pdf/);
	});
});

describe("startDraftSession with lectures", () => {
	function fakeFetch() {
		const calls: { body: Record<string, unknown> }[] = [];
		const f = (async (_url: string, init?: RequestInit) => {
			calls.push({ body: JSON.parse(String(init?.body)) });
			return new Response(JSON.stringify({ id: "c_1" }), { status: 200 });
		}) as typeof fetch;
		return { f, calls };
	}

	it("sends the pick as lectureContext on a teach create", async () => {
		const { f, calls } = fakeFetch();
		const lectures = pickRequest({ lec_1: { t2: "derivation" } });
		await startDraftSession("exam in a week", f, undefined, undefined, lectures);
		assert.deepEqual(calls[0]!.body, { title: "exam in a week", lectureContext: lectures });
	});

	it("sends nothing extra for an empty pick, and never on a practice create", async () => {
		const { f, calls } = fakeFetch();
		await startDraftSession("hello", f, undefined, undefined, pickRequest({}));
		assert.deepEqual(calls[0]!.body, { title: "hello" });
		await startDraftSession("drill", f, "practice", undefined, pickRequest({ lec_1: { t1: "overview" } }));
		assert.deepEqual(calls[1]!.body, { title: "drill", kind: "practice" });
	});
});
