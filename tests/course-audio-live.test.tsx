import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CourseAudio } from "../components/create/course-audio.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import type { AudioView } from "../src/core/contracts/create-audio.ts";

/**
 * The audio section in a live page (the static-markup tests of render-create.test.tsx cannot show this): a key saved in Settings
 * must reach the section without a reload — "Add the key" has to go away by itself once the key is there.
 */
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (root) await act(async () => root!.unmount());
	host?.remove();
	root = host = undefined;
});

const view = (keyConfigured: boolean): AudioView => ({
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
	sources: [{ jobId: "crt_a", name: "Heart lecture", pages: 12 }],
	keyConfigured,
	voiceId: "21m00Tcm4TlvDq8ikWAM",
	defaultVoiceId: "21m00Tcm4TlvDq8ikWAM",
	chars: 0,
});

test("a key saved in Settings reaches the audio section without a reload", async () => {
	let keyConfigured = false;
	let reads = 0;
	globalThis.fetch = (async (url: unknown) => {
		assert.equal(url, "/api/create/courses/cardio/audio");
		reads++;
		return Response.json({ audio: view(keyConfigured) });
	}) as typeof fetch;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<CourseAudio course={{ id: "cardio", name: "Cardiology", topics: [], strict: false, jobs: 1, drafts: 0 }} />));
	assert.equal(reads, 1);
	assert(document.querySelector('[data-testid="audio-nokey"]'), "no key yet: the section asks for it");

	keyConfigured = true;
	await act(async () => notifySettingsSaved("keys"));
	assert.equal(reads, 2, "the section read its view again");
	assert.equal(document.querySelector('[data-testid="audio-nokey"]'), null, "the key is there: the request is gone");

	await act(async () => notifySettingsSaved("general"));
	assert.equal(reads, 2, "other settings do not matter to it");
});
