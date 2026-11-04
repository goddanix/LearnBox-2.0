/**
 * Study card rendering — card → HTML for the review screen
 *
 * PURE and SCRIPT-FREE. A card's fields are HTML (MedAnki's, or whatever an
 * Anki deck carried), so the output is only ever shown inside a sandboxed
 * iframe with a CSP (`cardDocument`): no script, no remote loads. That is why
 * MedAnki's template JavaScript (hide the sibling gaps, place the red mark on
 * the figure) is re-done here statically:
 *  - cloze: the active gap (variant + 1) is "[...]" on the front and
 *    highlighted on the back; other gaps show their text — except on a
 *    Bildcloze (field LegendCloze set), where every other gap stays hidden.
 *  - Bildcloze split view (the BildclozeSplitView add-on's layout): figure
 *    left, gaps right, same on both sides so nothing jumps when revealing.
 *    The active gap's mark sits on the figure as a percent box inside a
 *    wrapper that shrink-wraps the image, so it cannot drift.
 *  - Bildverdeckung (occlusion): header + the covered image; the back swaps in
 *    the uncovered image and adds the answer.
 *  - MCQ: options A-D (empty ones left out). The front is the ONLY document
 *    that runs a script — our fixed one (`MCQ_SCRIPT`, allowed by a CSP nonce,
 *    deck scripts stay blocked): it toggles the clicked options and reports
 *    them to the page. The back is static: the page writes the picked letters
 *    into `data-lh-picked` (`applyPicked`) and CSS colours hit / missed / wrong.
 *  - media: `src="x"` and `[sound:x]` are resolved through a caller-supplied
 *    function — the server inlines the files as data: URIs, because the
 *    desktop shell only authorises /api requests of the MAIN frame, so a
 *    sandboxed iframe could not fetch them over HTTP.
 */

import type { StudyCard, StudyGrade } from "./contracts/study.ts";

export type CardFace = "front" | "back";

export interface RenderedFace {
	/** Body HTML (inside `.card`, or the split layout). */
	html: string;
	/** True for the Bildcloze figure-left / text-right layout. */
	split: boolean;
}

const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
const SRC_RE = /(\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const SOUND_RE = /\[sound:([^\]]+)\]/g;
const LEGEND_GAP_RE = /class="legend-gap"/g;
const KNOWN_BASIC_FIELDS = new Set(["Front", "Back", "Extra", "Source", "Reverse"]);
/** Gaps from which the legend wraps into two columns (the add-on's threshold). */
const WRAP_THRESHOLD = 8;

const escapeAttr = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Maps a media file name from a card (as written, maybe percent-encoded) to a
 *  URL the card document may load, or null when the file is missing. */
export type MediaResolver = (name: string) => string | null;

function decodeName(name: string): string {
	try {
		return decodeURIComponent(name);
	} catch {
		return name;
	}
}

/** Point local `src` attributes at resolved media, turn [sound:x] into players. */
export function resolveMedia(html: string, resolve: MediaResolver): string {
	const withSrc = html.replace(SRC_RE, (whole, attr: string, dq?: string, sq?: string) => {
		const value = dq ?? sq ?? "";
		if (value.length === 0 || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/")) return whole;
		return `${attr}"${escapeAttr(resolve(decodeName(value)) ?? "data:,")}"`;
	});
	return withSrc.replace(SOUND_RE, (_m, name: string) => {
		const url = resolve(decodeName(name));
		return url
			? `<audio controls preload="none" src="${escapeAttr(url)}"></audio>`
			: `<span class="missing-media">[sound missing: ${escapeAttr(name)}]</span>`;
	});
}

/** Expand cloze syntax for the active gap `active` (1-based). */
export function renderCloze(text: string, active: number, face: CardFace, hideOthers: boolean): string {
	return text.replace(CLOZE_RE, (_m, n: string, answer: string, hint?: string) => {
		if (Number(n) === active) {
			return face === "front"
				? `<span class="cloze">[${hint ?? "..."}]</span>`
				: `<span class="cloze">${answer}</span>`;
		}
		return hideOthers ? `<span class="cloze-hidden">[...]</span>` : `<span class="cloze-inactive">${answer}</span>`;
	});
}

const block = (cls: string, html: string | undefined): string =>
	html && html.trim().length > 0 ? `<div class="${cls}">${html}</div>` : "";

function tail(card: StudyCard): string {
	return block("extra", card.fields.Extra) + block("source", card.fields.Source);
}

function renderBasic(card: StudyCard, face: CardFace): string {
	const front = card.fields.Front ?? "";
	const back = card.fields.Back ?? "";
	const reversed = card.variant === 1;
	const question = reversed ? back : front;
	const answer = reversed ? front : back;
	if (face === "front") return `<div class="q">${question}</div>`;
	const others = Object.entries(card.fields)
		.filter(([name, value]) => !KNOWN_BASIC_FIELDS.has(name) && value.trim().length > 0)
		.map(([, value]) => block("extra", value))
		.join("");
	return `<div class="q">${question}</div><hr id="answer"><div class="a">${answer}</div>${others}${tail(card)}`;
}

/** The legend's markers: `<span class="legend-mark" data-n data-box="x0,y0,x1,y1">`. */
function markerStyle(box: string): string | null {
	const p = box.split(",").map(Number);
	if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) return null;
	const [x0, y0, x1, y1] = p as [number, number, number, number];
	const pct = (v: number) => `${Math.round(v * 10_000) / 100}%`;
	return `left:${pct(x0)};top:${pct(y0)};width:${pct(x1 - x0)};height:${pct(y1 - y0)}`;
}

function renderBildcloze(card: StudyCard, face: CardFace): RenderedFace {
	const active = (card.variant ?? 0) + 1;
	const raw = card.fields.Text ?? "";
	const imgMatch = /<img\b[^>]*>/i.exec(raw);
	if (!imgMatch) {
		const plain = renderCloze(raw, active, face, true);
		return { html: `<div class="q">${plain}</div>${face === "back" ? tail(card) : ""}`, split: false };
	}
	// the figure and the marker spans that directly follow it (+ one <br>)
	const after = raw.slice(imgMatch.index + imgMatch[0].length);
	const marks = /^(?:\s*<span\b[^>]*class="legend-mark"[^>]*>\s*<\/span>)*(?:\s*<br\s*\/?>)?/i.exec(after);
	const markHtml = marks?.[0] ?? "";
	const rest = raw.slice(0, imgMatch.index) + after.slice(markHtml.length);

	let mark = "";
	for (const m of markHtml.matchAll(/<span\b[^>]*>/gi)) {
		const tag = m[0];
		if (new RegExp(`data-n="${active}"`).test(tag)) {
			const box = /data-box="([^"]*)"/.exec(tag)?.[1];
			const style = box ? markerStyle(box) : null;
			if (style) mark = `<span class="legend-mark" style="${style}"></span>`;
		}
	}

	let legend = renderCloze(rest, active, face, true);
	if ((raw.match(LEGEND_GAP_RE) ?? []).length > WRAP_THRESHOLD) {
		legend = `<div class="bcsv-legend-grid">${legend}</div>`;
	}
	const html =
		`<div class="bcsv-layout"><div class="bcsv-img"><div class="bcsv-imgwrap">${imgMatch[0]}${mark}</div></div>` +
		`<div class="bcsv-text">${legend}${face === "back" ? tail(card) : block("source", card.fields.Source)}</div></div>`;
	return { html, split: true };
}

const header = (card: StudyCard, key: string): string => block("header", card.fields[key]);

function renderOcclusion(card: StudyCard, face: CardFace): string {
	if (face === "front") return header(card, "Header") + (card.fields.QuestionImage ?? "");
	return (
		header(card, "Header") +
		(card.fields.AnswerImage ?? "") +
		'<hr id="answer">' +
		block("answer", card.fields.Answer) +
		tail(card)
	);
}

const MCQ_KEYS = ["A", "B", "C", "D"] as const;

/** The correct option letters of an MCQ card ("B, C" → ["B", "C"]). */
export function mcqCorrect(fields: Record<string, string>): string[] {
	return MCQ_KEYS.filter((k) => (fields.Correct ?? "").replace(/[^A-D]/g, "").includes(k));
}

/** The grade to highlight after checking: Good when every correct option and no wrong one was picked, else Again. */
export function mcqSuggestedGrade(correct: readonly string[], picked: readonly string[]): StudyGrade {
	if (correct.length === 0) return 3;
	const exact = correct.length === picked.length && correct.every((k) => picked.includes(k));
	return exact ? 3 : 1;
}

/** Put the picked letters into a rendered MCQ back; CSS does the colouring. Non-letters are dropped. */
export function applyPicked(html: string, picked: readonly string[]): string {
	const letters = picked.filter((k) => (MCQ_KEYS as readonly string[]).includes(k));
	return html.replace('data-lh-picked=""', `data-lh-picked="${[...new Set(letters)].join(" ")}"`);
}

function renderMcq(card: StudyCard, face: CardFace): string {
	const correct = mcqCorrect(card.fields);
	const options = MCQ_KEYS.flatMap((k) => {
		const text = card.fields[`Option${k}`] ?? "";
		if (text.trim().length === 0) return [];
		const ok = face === "back" && correct.includes(k) ? " data-ok" : "";
		return [`<div class="mcq-opt" data-key="${k}"${ok}><b>${k}.</b> ${text}</div>`];
	}).join("");
	const wrap = face === "front" ? `<div class="mcq-opts">${options}</div>` : `<div class="mcq-opts mcq-back" data-lh-picked="">${options}</div>`;
	if (face === "front") return header(card, "Question") + wrap;
	return (
		header(card, "Question") +
		wrap +
		'<hr id="answer">' +
		(card.fields.Correct ? `<div class="answer">Correct: ${card.fields.Correct}</div>` : "") +
		block("mcq-explanation", card.fields.Explanation) +
		block("source", card.fields.Source)
	);
}

function renderCard(card: StudyCard, face: CardFace): RenderedFace {
	if (card.kind === "cloze") {
		if ((card.fields.LegendCloze ?? "") !== "") return renderBildcloze(card, face);
		const text = renderCloze(card.fields.Text ?? "", (card.variant ?? 0) + 1, face, false);
		return { html: `<div class="q">${text}</div>${face === "back" ? tail(card) : ""}`, split: false };
	}
	if (card.kind === "basic") return { html: renderBasic(card, face), split: false };
	if (card.kind === "occlusion") return { html: renderOcclusion(card, face), split: false };
	if (card.kind === "mcq") return { html: renderMcq(card, face), split: false };
	return {
		html: `<div class="q">Card type “${card.kind}” is not supported in the review screen yet.</div>`,
		split: false,
	};
}

/** One side of a card as body HTML, media resolved through `resolve`. */
export function renderFace(card: StudyCard, face: CardFace, resolve: MediaResolver): RenderedFace {
	const r = renderCard(card, face);
	return { html: resolveMedia(r.html, resolve), split: r.split };
}

// ─── the iframe document ────────────────────────────────────────────────────

export const CARD_CSS = `
:root { color-scheme: light dark; --fg:#1d1d1f; --bg:#fff; --accent:#1a6fd6; --muted:#8a8f98; --rule:#c9ced6; --extra:#b0b8c4; }
:root.dark { --fg:#e6e6e6; --bg:#141414; --accent:#6cb0ff; --muted:#9aa0a8; --rule:#3a4048; --extra:#59616b; }
html, body { height:100%; margin:0; }
body { font-family:-apple-system,"Helvetica Neue",Arial,sans-serif; font-size:20px; line-height:1.4; color:var(--fg); background:var(--bg); }
.card { box-sizing:border-box; max-width:760px; margin:0 auto; padding:24px 16px; min-height:100%; display:flex; flex-direction:column; justify-content:center; }
.cloze { font-weight:bold; color:var(--accent); }
.cloze-hidden { color:var(--muted); }
.extra { margin-top:12px; padding:8px 10px; border-left:3px solid var(--extra); font-size:17px; opacity:.92; }
.source { margin-top:14px; font-size:12px; color:var(--muted); }
.a { font-weight:600; }
.missing-media { color:var(--muted); font-size:13px; }
img { max-width:100%; height:auto; }
audio { width:100%; margin-top:8px; }
hr#answer { border:none; border-top:1px solid var(--rule); margin:12px 0; }
.bcsv-layout { display:flex; width:100%; height:100%; box-sizing:border-box; }
.bcsv-img { width:50%; height:100%; display:flex; align-items:center; justify-content:center; box-sizing:border-box; padding:16px; border-right:1px solid rgba(128,128,128,.25); }
.bcsv-imgwrap { position:relative; display:inline-block; line-height:0; max-width:100%; max-height:100%; }
.bcsv-imgwrap img { display:block; max-width:100%; max-height:calc(100vh - 32px); width:auto; height:auto; }
.legend-mark { position:absolute; box-sizing:border-box; border:3px solid #ff3b30; border-radius:50%; box-shadow:0 0 0 2px rgba(255,59,48,.35); pointer-events:none; }
.bcsv-text { width:50%; height:100%; overflow-y:auto; box-sizing:border-box; padding:24px 32px; display:flex; flex-direction:column; justify-content:center; }
.bcsv-legend-grid { column-count:2; column-gap:28px; }
.header { font-weight:600; margin-bottom:8px; }
.answer { margin-top:10px; font-weight:600; }
.mcq-opts { margin:10px 0; }
.mcq-opt { padding:9px 12px; margin-bottom:7px; border:1.5px solid var(--rule); border-radius:9px; cursor:pointer; }
.mcq-opt b { margin-right:4px; }
.mcq-opt.mcq-selected { border-color:var(--accent); background:rgba(26,111,214,.10); }
.mcq-back .mcq-opt { cursor:default; }
.mcq-back .mcq-opt[data-ok] { border-color:#1f9d55; border-style:dashed; background:rgba(31,157,85,.06); }
.mcq-explanation { margin-top:10px; }
${["A", "B", "C", "D"]
	.map(
		(k) =>
			`.mcq-back[data-lh-picked~="${k}"] .mcq-opt[data-key="${k}"][data-ok]{border-style:solid;background:rgba(31,157,85,.16)}` +
			`.mcq-back[data-lh-picked~="${k}"] .mcq-opt[data-key="${k}"]:not([data-ok]){border-color:#c53030;background:rgba(197,48,48,.16)}`,
	)
	.join("\n")}
`;

/** The one script an MCQ front may run (allowed by nonce): toggle the clicked option and tell the page
 *  which letters are picked. `parent.postMessage` is the only thing it can reach. */
export const MCQ_SCRIPT =
	'(function(){var w=document.querySelector(".mcq-opts");if(!w)return;' +
	"function report(){var p=[];w.querySelectorAll(\".mcq-opt.mcq-selected\").forEach(function(o){p.push(o.getAttribute(\"data-key\"));});parent.postMessage({lhMcq:p},\"*\");}" +
	'w.querySelectorAll(".mcq-opt").forEach(function(o){o.addEventListener("click",function(){o.classList.toggle("mcq-selected");report();});});})();';

/** A complete, self-contained document for the sandboxed iframe's `srcdoc`.
 *  The CSP allows only inline style and data: media — nothing else loads. With
 *  `mcqNonce` (an MCQ front) it also allows MCQ_SCRIPT, and nothing else, to run. */
export function cardDocument(body: string, opts: { dark: boolean; mcqNonce?: string }): string {
	const script = opts.mcqNonce ? `; script-src 'nonce-${opts.mcqNonce}'` : "";
	const csp = `default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'${script}`;
	const wrapped = body.startsWith('<div class="bcsv-layout"') ? body : `<div class="card">${body}</div>`;
	const code = opts.mcqNonce ? `<script nonce="${opts.mcqNonce}">${MCQ_SCRIPT}</script>` : "";
	return (
		`<!doctype html><html class="${opts.dark ? "dark" : ""}"><head><meta charset="utf-8">` +
		`<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">` +
		`<style>${CARD_CSS}</style></head><body>${wrapped}${code}</body></html>`
	);
}
