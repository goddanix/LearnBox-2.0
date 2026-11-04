/**
 * A card draft becomes study cards (Learnbox 2.0, 2026-11): the field mapping of MedAnki's export
 * (export.py) onto the study card kinds the review screen renders (core/study-render.ts):
 *   basic / process → "basic" (Front, Back, Extra, Source),
 *   basic_reversed  → two "basic" cards, variant 0 and 1,
 *   whole-figure cloze → one "cloze" card per gap (variant = gap − 1), with the figure and its markers,
 *   image occlusion → "occlusion" (Header, QuestionImage, AnswerImage, Answer).
 * The draft's plain text becomes the HTML the fields carry (escaped, **bold**, the Latin terms' English
 * addition in brackets); pictures are named files of the job's media folder, copied to the study media.
 * The card ids derive from job + draft, so adopting a draft twice cannot make a second card.
 */

import { CLOZE_RE } from "./card-util.ts";
import type { CardDraft } from "./contracts/create-cards.ts";
import type { StudyCard } from "./contracts/study.ts";

const LATIN_EN_RE = /\[\[en:([\s\S]*?)\]\]/g;

/** One gap's colour in a whole-figure cloze (taken in turn): tells the learner which term is asked while the others are revealed. */
export const CLOZE_COLORS = [
	"#1a6fd6", "#d6361a", "#1ab06c", "#b06c1a", "#8a3fd6", "#d61a8a",
	"#1ab0b0", "#6c8a1a", "#d6a01a", "#3f6cd6", "#c23f3f", "#1a8a6c",
	"#8a4b1a", "#5a1ad6", "#1a8ad6", "#a01a6c",
];

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** "[[en:median nerve]]" (in already escaped text) → the coloured bracket addition. */
const latinEn = (s: string): string => s.replace(LATIN_EN_RE, (_m, en: string) => ` <span class="latin-en">(${en})</span>`);

/** Plain text → card HTML: escape, **bold**, the Latin terms' English addition, line breaks. Cloze syntax stays. */
export function fmt(s: string | null | undefined): string {
	const escaped = escapeHtml(s ?? "").replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>");
	return latinEn(escaped).replace(/\n/g, "<br>");
}

/** Like fmt, but every gap {{cN::answer}} of a whole-figure cloze gets its own colour and a class that lets the page hide the sibling gaps. */
export function fmtClozeColored(text: string | null | undefined): string {
	const s = text ?? "";
	const out: string[] = [];
	let pos = 0;
	for (const m of s.matchAll(new RegExp(CLOZE_RE))) {
		out.push(latinEn(escapeHtml(s.slice(pos, m.index)).replace(/\n/g, "<br>")));
		const n = m[1]!;
		const color = CLOZE_COLORS[(Number(n) - 1) % CLOZE_COLORS.length]!;
		out.push(`{{c${n}::<span class="legend-gap" data-n="${n}" style="color:${color}">${latinEn(escapeHtml(m[2]!))}</span>}}`);
		pos = m.index + m[0].length;
	}
	out.push(latinEn(escapeHtml(s.slice(pos)).replace(/\n/g, "<br>")));
	return out.join("");
}

const img = (name: string | null | undefined): string => (name ? `<img src="${name}">` : "");

/** The figure of a whole-figure cloze with one (hidden until its turn) marker per gap whose number stands in the picture. */
export function legendImageHtml(file: string | null | undefined, markerBoxes: Record<string, readonly number[]>): string {
	const picture = img(file);
	if (!picture || Object.keys(markerBoxes).length === 0) return picture;
	const marks = Object.entries(markerBoxes)
		.map(([n, b]) => `<span class="legend-mark" data-n="${escapeHtml(n).replace(/"/g, "&quot;")}" data-box="${b.map((v) => v.toFixed(4)).join(",")}"></span>`)
		.join("");
	return picture + marks;
}

/** The job name as a tag part ("Anatomy Lecture 3.pdf" → "Anatomy_Lecture_3_pdf"). */
export const tagPart = (s: string): string => s.replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "Document";

export interface AdoptContext {
	jobId: string;
	jobName: string;
	courseId: string;
	/** ISO time of the adoption. */
	at: string;
}

/** The id of a draft's first study card; the others of the draft add `_v<k>`. */
export const studyCardId = (jobId: string, draftId: string, k = 0): string => `crt_${jobId}_${draftId}${k > 0 ? `_v${k}` : ""}`;

/** The picture files of a draft that its study cards will reference. */
export function mediaOf(c: CardDraft): string[] {
	const names = c.type === "image_occlusion" ? [c.questionFile, c.answerFile] : [c.image?.file];
	return names.filter((n): n is string => Boolean(n));
}

/** The gap numbers of a cloze text, ascending. */
const gapNumbers = (text: string): number[] => [...new Set([...text.matchAll(new RegExp(CLOZE_RE))].map((m) => Number(m[1])))].sort((a, b) => a - b);

/** A draft → its study cards (none when it cannot be shown, e.g. an occlusion whose pictures were never rendered). */
export function draftToStudyCards(c: CardDraft, ctx: AdoptContext): StudyCard[] {
	const source = `${ctx.jobName} · p. ${c.page}`;
	const tags = [`Create::${tagPart(ctx.jobName)}::S${String(c.page).padStart(3, "0")}`, ...(c.type === "process" ? ["Create::Process"] : []), ...c.tags];
	const make = (k: number, kind: StudyCard["kind"], fields: Record<string, string>, variant?: number): StudyCard => ({
		id: studyCardId(ctx.jobId, c.id, k),
		courseId: ctx.courseId,
		topic: ctx.jobName,
		kind,
		fields,
		tags,
		core: c.tier === 1,
		tier: c.tier,
		origin: { kind: "pdf", jobId: ctx.jobId, page: c.page, draftId: c.id },
		...(variant === undefined ? {} : { variant }),
		createdAt: ctx.at,
	});

	let extra = fmt(c.extra);
	if (c.type === "cloze") {
		let text = fmtClozeColored(c.text);
		if (c.image?.file) {
			if (c.image.where === "front") text = `${legendImageHtml(c.image.file, c.markerBoxes)}<br>${text}`;
			else extra += (extra ? "<br>" : "") + img(c.image.file);
		}
		const fields = { Text: text, Extra: extra, Source: source, LegendCloze: "1" };
		return gapNumbers(c.text).map((n, k) => make(k, "cloze", fields, n - 1));
	}
	if (c.type === "image_occlusion") {
		if (!c.questionFile || !c.answerFile) return [];
		const answer = fmt(c.label) + (c.hint ? `<br><small>${fmt(c.hint)}</small>` : "");
		return [make(0, "occlusion", { Header: fmt(c.header), QuestionImage: img(c.questionFile), AnswerImage: img(c.answerFile), Answer: answer, Extra: extra, Source: source })];
	}
	let front = fmt(c.front);
	if (c.image?.file) {
		if (c.image.where === "front") front += `<br>${img(c.image.file)}`;
		else extra += (extra ? "<br>" : "") + img(c.image.file);
	}
	const fields = { Front: front, Back: fmt(c.back), Extra: extra, Source: source, Reverse: c.type === "basic_reversed" ? "y" : "" };
	return c.type === "basic_reversed" ? [make(0, "basic", fields, 0), make(1, "basic", fields, 1)] : [make(0, "basic", fields)];
}
