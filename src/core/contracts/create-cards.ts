/**
 * Card-draft contracts (Learnbox 2.0, 2026-11): what a "cards" Create job holds
 * per page. Ported from MedAnki's card model (medanki/cards.py): the model's
 * answer for one PDF page, validated and normalised into DRAFT cards — front /
 * back questions, process cards with a picture, image-occlusion cards and the
 * whole-image cloze of the atlas mode. Nothing here reaches the study ledgers
 * until the learner adopts a draft (server/create-cards.ts).
 *
 * Boxes are [x0, y0, x1, y1] normalised to the page, origin top left (the same
 * frame as the page layout, core/contracts/page-layout.ts).
 */

import type { Box } from "./page-layout.ts";
import type { Adoption, CreateJobSummary, CreateLanguage, CreatePageStatus } from "./create.ts";

/** How many cards a page should yield: "concept" asks for understanding questions instead of single facts. */
export const CARD_DENSITIES = ["brief", "normal", "thorough", "concept"] as const;
export type CardDensity = (typeof CARD_DENSITIES)[number];

/** Image-occlusion mode: the model decides, or one covered label / all labels covered. */
export const CARD_IO_MODES = ["auto", "one", "all"] as const;
export type CardIoMode = (typeof CARD_IO_MODES)[number];

/** Latin anatomical terms in the answers: on, off, or on when the lecture looks like anatomy. */
export const CARD_LATIN_MODES = ["auto", "on", "off"] as const;
export type CardLatinMode = (typeof CARD_LATIN_MODES)[number];

export const CARD_KINDS = ["lecture", "practical"] as const;
export type CardMaterialKind = (typeof CARD_KINDS)[number];

/** What the learner can set for a cards job (MedAnki's job settings, minus what a later slice owns: deck, course). */
export interface CardSettings {
	/** Claude model for the cards (alias like "sonnet" or a full id). */
	model: string;
	density: CardDensity;
	language: CreateLanguage;
	ioMode: CardIoMode;
	latinTerms: CardLatinMode;
	/** One cloze card per labelled figure instead of one occlusion card per label — for atlases with the same layout on every page. */
	wholeImageCards: boolean;
	/** Topics the cards should favour (soft) or be limited to (strict). */
	focusTopics: string[];
	focusStrict: boolean;
	kind: CardMaterialKind;
	/** A vocabulary sheet of a language course: plain word pairs, nothing else. */
	vocab: boolean;
	/** The course language (front of the vocabulary cards is English, the back is this). */
	vocabLang: string;
	/** 1-based, inclusive; the job clamps them to the PDF. */
	pageFrom: number;
	pageTo: number;
	/** Pages processed at the same time (1–4). */
	concurrency: number;
}

export const DEFAULT_CARD_SETTINGS: CardSettings = {
	model: "sonnet",
	density: "normal",
	language: "en",
	ioMode: "auto",
	latinTerms: "auto",
	wholeImageCards: false,
	focusTopics: [],
	focusStrict: false,
	kind: "lecture",
	vocab: false,
	vocabLang: "Czech",
	pageFrom: 1,
	pageTo: 0, // 0 = to the end
	concurrency: 2,
};

/** Vocabulary sheets: at most this many cards per page (the most important words). */
export const VOCAB_MAX_PER_PAGE = 10;

/** 1 core knowledge, 2 good to know, 3 detail questions. */
export type CardTier = 1 | 2 | 3;

export type CardType = "basic" | "basic_reversed" | "process" | "cloze" | "image_occlusion";

/** A picture on a front/back card: the part of the page, where it sits, and the rendered file once it exists. */
export interface CardImage {
	bbox: Box;
	/** "front": instead of / above the question; "extra": under the answer. */
	where: "front" | "extra";
	/** File name in the job's media folder; null until rendered. */
	file: string | null;
}

export interface CardBase {
	/** "p003-c02" — page 3, second card of the page. */
	id: string;
	page: number;
	tier: CardTier;
	/** The model's one-line reason for the card type. */
	whyType: string;
	extra: string;
	/** A short quote from the page text the card rests on. */
	evidence: string;
	tags: string[];
	/** Quality / evidence warnings (learner-facing English). */
	warnings: string[];
	/** Soft delete: thrown away by the learner, the critic or the duplicate check (restorable). */
	deleted: boolean;
	/** Selected for adoption. */
	include: boolean;
	/** Made by hand in the focus screen, never by the model. */
	manual: boolean;
	/** Line ids the card was made from, and their box on the page (the focus screen marks it). */
	sourceIds: string[];
	sourceBbox: Box | null;
	image: CardImage | null;
	/** Why the card was changed or thrown away by the machine ("Duplicate of p001-c02", critic verdicts …). */
	note?: string;
	/** Edited by the learner / brought back after a machine deletion: never removed automatically. */
	edited?: boolean;
	restored?: boolean;
	/** The labels the card had before "assign to topics" replaced them (so the assignment can be undone). */
	prevTags?: string[];
	/** Set once the draft became a study card. */
	adopted?: Adoption;
}

/** basic (question → answer), basic_reversed (both directions) and process (picture + steps in order). */
export interface FrontBackCard extends CardBase {
	type: "basic" | "basic_reversed" | "process";
	front: string;
	back: string;
}

/** The atlas mode's whole-figure cloze: the figure with every label's number visible and its name a gap. */
export interface LegendClozeCard extends CardBase {
	type: "cloze";
	text: string;
	legendCloze: true;
	/** Gap number → box of the printed number inside the figure (figure-local 0..1). */
	markerBoxes: Record<string, Box>;
	/** Gap number → the printed number it should find. */
	markerNums: Record<string, string>;
}

/** One covered label of a labelled figure; the labels of one figure are separate cards sharing the picture. */
export interface OcclusionCard extends CardBase {
	type: "image_occlusion";
	header: string;
	mode: "one" | "all";
	/** The part of the page shown (figure and its labels). */
	figureBbox: Box;
	/** The learner picked the part: it may not be enlarged automatically. */
	figureExact: boolean;
	/** The mask was drawn by hand: render exactly as drawn. */
	maskExact: boolean;
	label: string;
	hint: string;
	/** The mask(s) of THIS card, page-normalised. */
	boxes: Box[];
	/** The printed number inside the figure, when the label sits in a legend. */
	markerBbox: Box | null;
	/** Masks of every card of the figure (the "all" mode covers them together). */
	allBoxes: Box[];
	/** The box is a guess (no text line to anchor on): look at the picture. */
	needsCheck: boolean;
	/** The legend fallback made this group, not the model. */
	autoLegend?: boolean;
	questionFile: string | null;
	answerFile: string | null;
	/** Perceptual hash of the figure (finds the same figure on another page). */
	figHash?: string;
	/** The mask planner's version of the last rendering (core/card-media.ts MASK_VERSION). */
	maskV?: number;
}

export type CardDraft = FrontBackCard | LegendClozeCard | OcclusionCard;

/** A card the model offered that normalisation refused, with the reason (learner-facing English). */
export interface DroppedCard {
	reason: string;
	raw: unknown;
}

export type CardPageStatus = "done" | "skipped";

export interface CardPageResult {
	page: number;
	pageType: string;
	skip: boolean;
	skipReason: string;
	/** The model's short title of the page. */
	topic: string;
	status: CardPageStatus;
	cards: CardDraft[];
	dropped: DroppedCard[];
}

/** A group of cards that ask for the same thing (the duplicate review). */
export interface DuplicateGroup {
	id: string;
	kind: "text" | "occlusion";
	reason: string;
	score: number;
	/** Id of the card to keep. */
	keep: string;
	/** The keeper first. */
	cards: CardDraft[];
	/** Found by Claude's content check, not by the text/position comparison. */
	semantic?: true;
}

/** The duplicate review of a job: the groups to look at and how many cards were removed on their own already. */
export interface DuplicateReview {
	groups: DuplicateGroup[];
	autoRemoved: number;
}

/** What Claude's content check of duplicates has done so far in a job: every card is asked about only once. */
export interface DedupeCache {
	/** Ids of the cards already given to Claude. */
	checked: string[];
	/** Groups of card ids Claude called the same thing (never removed automatically). */
	groups: { cards: string[] }[];
}

/** One step of the content check (one call to Claude); the screen repeats it until `done`. */
export interface SemanticStep {
	checkedNow: number;
	/** Candidate pairs not yet checked. */
	remaining: number;
	groups: DuplicateGroup[];
	done: boolean;
	error: string | null;
}

/** One canonical spelling for the whole document, with the variants it replaces (the term glossary). */
export interface GlossaryTerm {
	canonical: string;
	variants: string[];
}

/** One page for the card list. */
export interface CardJobPageView {
	page: number;
	status: CreatePageStatus;
	error?: string;
	/** The model's short title of the page. */
	topic: string;
	/** The page held nothing to learn (title page, table of contents …) — with the model's reason. */
	skipped: boolean;
	skipReason: string;
	cards: CardDraft[];
	/** Cards the model offered that were refused (with reasons in the page file). */
	dropped: number;
}

export interface CardsJobDetail {
	job: CreateJobSummary;
	settings: CardSettings;
	pages: CardJobPageView[];
}

// ─── subjects (courses) and their topics ─────────────────────────────────────

/** A subject as the Create area shows it: its topics, and the PDFs and drafts made for it. */
export interface CreateCourse {
	id: string;
	name: string;
	topics: string[];
	/** Only these topics: the PDFs made for the subject skip pages about anything else. */
	strict: boolean;
	deadline?: string;
	/** Cards jobs (PDFs) made for the subject, and the drafts (not deleted) they hold now. */
	jobs: number;
	drafts: number;
}

/** A draft of a subject with the PDF it comes from (card ids are unique within a PDF only). */
export interface CourseDraft {
	jobId: string;
	jobName: string;
	card: CardDraft;
}

/** A topic label on the drafts of a subject: drafts selected for adoption, and all drafts with it. */
export interface CourseTag {
	tag: string;
	selected: number;
	total: number;
}

/** What a list of topics from a file did to the subject's topics. */
export interface TopicsFromFile {
	course: CreateCourse;
	source: "txt" | "pdf";
	/** Entries found in the file. */
	found: number;
	/** Of those, the ones that belong to a topic set already. */
	matched: number;
	/** Topics the file added. */
	added: string[];
}

/** A tidied topic list Claude suggests; nothing is saved until the learner takes it. */
export interface ProposedTopic {
	name: string;
	/** From the learner's list, or found on the lecture pages. */
	source: "list" | "lecture";
}

export interface TopicProposal {
	topics: ProposedTopic[];
	current: string[];
}

/** The assignment of a subject's drafts to its topics (runs in the background). */
export interface AssignStatus {
	state: "none" | "running" | "done" | "error";
	done: number;
	total: number;
	/** Drafts given a topic, and those that fit none ("Other"). */
	result: { assigned: number; other: number; skipped: number } | null;
	error: string;
}

/** A card of a duplicate group across the PDFs of a subject. `ref` ("jobId|cardId") names it in a removal. */
export interface CourseGroupCard {
	ref: string;
	jobId: string;
	jobName: string;
	card: CardDraft;
}

export interface CourseDuplicateGroup {
	id: string;
	kind: "text" | "occlusion";
	reason: string;
	score: number;
	/** `ref` of the card to keep. */
	keep: string;
	/** The keeper first. */
	cards: CourseGroupCard[];
	semantic?: true;
}

export interface CourseDuplicateReview {
	groups: CourseDuplicateGroup[];
	semantic: CourseDuplicateGroup[];
	autoRemoved: number;
}

export interface CourseSemanticStep {
	checkedNow: number;
	remaining: number;
	groups: CourseDuplicateGroup[];
	done: boolean;
	error: string | null;
}
