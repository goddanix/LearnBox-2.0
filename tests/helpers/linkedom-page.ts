/**
 * A linkedom page as the global document, for tests that render components into it. Import it BEFORE
 * react-dom: React decides at import time whether the page can take text input (`window.document` exists and
 * has an `oninput`), and without that its text fields never report a change.
 */
import { parseHTML } from "linkedom";

export const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLIFrameElement: dom.window.HTMLIFrameElement,
	CustomEvent: dom.window.CustomEvent,
	Event: dom.window.Event,
	// next/link's visibility effect schedules through self.requestIdleCallback when there is no IntersectionObserver
	self: globalThis,
	IS_REACT_ACT_ENVIRONMENT: true,
});
(dom.document as unknown as { oninput: null }).oninput = null;
