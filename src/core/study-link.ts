/**
 * Study ↔ lesson links, the pure part (Learnbox 2.0, 2026-11, Slice 9)
 *
 * Three rules live here: which cards are a course's weak spots (the most lapses, derived by
 * folding the review ledger through FSRS like the queue does), how a card reads as plain text
 * (the lesson and the model never see the review screen's HTML), and the `study-context` marker
 * — a separate custom message before the learner's first message that tells the teacher about
 * the course and the cards the lesson started from. Same law as the graph marker:
 * `content` is what the model reads (bracket convention, because markers flatten to user-role
 * messages), `details` is the transcript card's payload. The request that starts a lesson names
 * ids only; the text is always read from the ledgers (core never trusts text from a URL).
 */

import type { StudyCard, StudyCourse, StudyReview } from "./contracts/study.ts";
import {
	CONTEXT_WEAK_LIMIT,
	LINK_TEXT_CAP,
	WEAK_LIST_LIMIT,
	WEAK_MIN_LAPSES,
	type StudyContextCourse,
	type StudyContextData,
	type StudyLinkCard,
} from "./contracts/study-link.ts";
import { daysUntil } from "./deadline.ts";
import { replay } from "./fsrs.ts";
import { newMessageId, type LhMarkerMessage } from "./native-messages.ts";
import { courseFsrsOptions } from "./study-queue.ts";

// ─── a card as plain text ────────────────────────────────────────────────────

const ENTITIES: Array<[RegExp, string]> = [
	[/&nbsp;/g, " "],
	[/&lt;/g, "<"],
	[/&gt;/g, ">"],
	[/&quot;/g, '"'],
	[/&#39;/g, "'"],
	[/&amp;/g, "&"],
];

/** Card HTML as one line of text: tags dropped, breaks and blocks as spaces, pictures as "[figure]". */
export function plainText(html: string): string {
	let s = html
		.replace(/<img\b[^>]*>/gi, " [figure] ")
		.replace(/<\/?(?:br|p|div|li|ul|ol|hr|tr|td|th)\b[^>]*>/gi, " ")
		.replace(/<[^>]+>/g, "");
	for (const [re, to] of ENTITIES) s = s.replace(re, to);
	return s.replace(/\s+/g, " ").trim();
}

const cap = (s: string): string => (s.length > LINK_TEXT_CAP ? `${s.slice(0, LINK_TEXT_CAP - 1).trimEnd()}…` : s);

const CLOZE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

/** A cloze text for one face: the active gap hidden on the front, everything filled in otherwise. */
function clozePlain(raw: string, active: number, face: "front" | "back"): string {
	return raw.replace(CLOZE, (_m, n: string, answer: string, hint?: string) =>
		face === "front" && Number(n) === active ? `[${hint && hint.length > 0 ? hint : "..."}]` : answer,
	);
}

const MCQ_KEYS = ["A", "B", "C", "D"] as const;

function faces(card: StudyCard): { front: string; back: string } {
	const f = card.fields;
	switch (card.kind) {
		case "basic": {
			const [question, answer] = card.variant === 1 ? [f.Back, f.Front] : [f.Front, f.Back];
			return { front: question ?? "", back: answer ?? "" };
		}
		case "cloze": {
			const active = (card.variant ?? 0) + 1;
			const raw = f.Text ?? "";
			return {
				front: clozePlain(raw, active, "front"),
				back: [clozePlain(raw, active, "back"), f.Extra ?? ""].filter((x) => x.trim().length > 0).join(" "),
			};
		}
		case "occlusion":
			return {
				front: f.Header && f.Header.trim().length > 0 ? f.Header : "Image occlusion card",
				back: [f.Answer ?? "", f.Header ?? ""].filter((x) => x.trim().length > 0).join(" "),
			};
		case "mcq": {
			const options = MCQ_KEYS.flatMap((k) => ((f[`Option${k}`] ?? "").trim().length > 0 ? [`${k}. ${f[`Option${k}`]}`] : []));
			return {
				front: [f.Question ?? "", ...options].filter((x) => x.trim().length > 0).join(" "),
				back: [f.Correct ? `Correct: ${f.Correct}.` : "", f.Explanation ?? ""].filter((x) => x.trim().length > 0).join(" "),
			};
		}
	}
}

/** A card as the lessons see it. */
export function linkCard(card: StudyCard, lapses: number): StudyLinkCard {
	const { front, back } = faces(card);
	return { id: card.id, front: cap(plainText(front)), back: cap(plainText(back)), lapses };
}

// ─── weak spots ──────────────────────────────────────────────────────────────

/** The lapses of a card from its (effective) reviews; 0 for a card never reviewed. */
export function lapsesOf(course: StudyCourse, card: StudyCard, reviews: readonly StudyReview[] | undefined, today: string): number {
	if (!reviews || reviews.length === 0) return 0;
	return replay(card.id, reviews, courseFsrsOptions(course, today))?.lapses ?? 0;
}

/**
 * The course's weak spots: unsuspended cards with at least `minLapses` lapses, most lapses first
 * (FSRS difficulty, then the id, break ties so the order never jumps between calls).
 */
export function weakSpots(
	course: StudyCourse,
	cards: readonly StudyCard[],
	reviewsByCard: ReadonlyMap<string, readonly StudyReview[]>,
	today: string,
	opts: { minLapses?: number; limit?: number } = {},
): StudyLinkCard[] {
	const min = opts.minLapses ?? WEAK_MIN_LAPSES;
	const fsrs = courseFsrsOptions(course, today);
	const rows: Array<{ card: StudyCard; lapses: number; difficulty: number }> = [];
	for (const card of cards) {
		if (card.courseId !== course.id || card.suspended) continue;
		const reviews = reviewsByCard.get(card.id);
		if (!reviews || reviews.length === 0) continue;
		const state = replay(card.id, reviews, fsrs);
		if (!state || state.lapses < min) continue;
		rows.push({ card, lapses: state.lapses, difficulty: state.difficulty });
	}
	rows.sort((a, b) => b.lapses - a.lapses || b.difficulty - a.difficulty || a.card.id.localeCompare(b.card.id));
	return rows.slice(0, opts.limit ?? WEAK_LIST_LIMIT).map((r) => linkCard(r.card, r.lapses));
}

// ─── the marker ──────────────────────────────────────────────────────────────

/** The marker payload for a course, today's counts, its weak list and the cards picked for the lesson. */
export function buildStudyContext(input: {
	course: StudyCourse;
	today: string;
	due: number;
	newToday: number;
	/** The whole weak list (the picked ones are left out of what the teacher hears). */
	weakAll: readonly StudyLinkCard[];
	picked: readonly StudyLinkCard[];
}): StudyContextData {
	const { course } = input;
	const pickedIds = new Set(input.picked.map((c) => c.id));
	const ctxCourse: StudyContextCourse = {
		id: course.id,
		name: course.name,
		topics: course.topics ?? [],
		...(course.strictTopics ? { strictTopics: true } : {}),
		...(course.deadline ? { deadline: course.deadline } : {}),
		daysToExam: course.deadline ? daysUntil(course.deadline, input.today) : null,
	};
	return {
		course: ctxCourse,
		due: input.due,
		newToday: input.newToday,
		weak: input.weakAll.filter((c) => !pickedIds.has(c.id)).slice(0, CONTEXT_WEAK_LIMIT),
		cards: [...input.picked],
	};
}

const noun = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function examLine(c: StudyContextData["course"]): string {
	if (!c.deadline || c.daysToExam === null) return "no exam date set.";
	if (c.daysToExam < 0) return `the exam was on ${c.deadline} (passed).`;
	if (c.daysToExam === 0) return `the exam is today (${c.deadline}).`;
	return `exam on ${c.deadline} (${noun(c.daysToExam, "day", "days")} left).`;
}

/** What the model reads: the whole marker as one text (approved wording, 2026-11-05). */
export function studyContextText(d: StudyContextData): string {
	const c = d.course;
	const lines = [
		d.cards.length > 0
			? "[Session context] — the learner started this session from their flashcards."
			: "[Session context] — the course this session belongs to.",
		"",
		`Course: ${c.name} — ${examLine(c)}`,
	];
	if (c.topics.length > 0) lines.push(`Topics: ${c.topics.join("; ")}${c.strictTopics ? " (only these topics count)" : ""}`);
	lines.push(`Study state: ${noun(d.due, "card", "cards")} due, ${d.newToday} new today.`);
	if (d.weak.length > 0) {
		lines.push("Weakest cards of the course (most lapses):", ...d.weak.map((w) => `- "${w.front}" (${noun(w.lapses, "lapse", "lapses")})`));
	}
	if (d.cards.length > 0) {
		lines.push(
			"",
			"Cards the learner picked for this lesson (they keep getting these wrong):",
			...d.cards.map((x) => `- [${x.id}] Front: ${x.front} | Back: ${x.back} | ${noun(x.lapses, "lapse", "lapses")}`),
		);
	}
	if (d.cards.length > 0 || d.weak.length > 0) {
		lines.push("", "These cards show what the learner was asked to memorise, NOT what they understand — find out where it breaks down before teaching.");
	}
	return lines.join("\n");
}

/** The marker message: a separate custom message BEFORE the learner's first user message. */
export function newStudyContextMessage(data: StudyContextData): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "study-context",
		content: studyContextText(data),
		display: true,
		details: data,
		timestamp: Date.now(),
	};
}

/** The draft's suggested first message when a lesson starts from cards (the learner may change it). */
export function suggestedFirstMessage(cardCount: number): string {
	return `I keep getting ${cardCount === 1 ? "this card" : "these cards"} wrong. Find out where my understanding breaks down, then teach me what I'm missing.`;
}
