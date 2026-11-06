/**
 * Start the Anki cards over (Learnbox 2.0): remove what an earlier Anki import put into the study ledgers, then import
 * the collection again under a new plan (scripts/anki-reset-import.ts is the command line for it).
 *
 * What goes: every card whose origin is `anki-import` (all its ledger lines, tombstones included), the reviews of
 * those cards, and a course that held nothing but such cards (unless the owner gave it topics or a vault link).
 * What stays, line for line: cards made by hand / from PDFs / from the graph, their reviews, every other course, the
 * media folder. Nothing is touched before a copy of the three ledgers sits in the backup folder; the rewrite is atomic
 * per file (temp file + rename) and is rolled back from the backup if one of the three writes fails.
 *
 * Nothing here reads or changes the Anki collection beyond `readAnkiCollection`, which works on a copy.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	inspectCollection,
	mapCollection,
	parseImportPlan,
	suggestPlan,
	type DeckPlacement,
	type ImportOutcome,
	type ImportPlan,
} from "../core/anki-import.ts";
import type { StudyCard, StudyCourse, StudyReview } from "../core/contracts.ts";
import { readAnkiCollection } from "../store/anki-source.ts";
import { createStudyStore, type StudyFiles } from "../store/study.ts";
import { runAnkiImport } from "./anki-import.ts";

// ─── ledger text ─────────────────────────────────────────────────────────────

type Line = Record<string, unknown>;
const isLine = (v: unknown): v is Line => typeof v === "object" && v !== null && !Array.isArray(v);

function readText(file: string): string {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return ""; // no ledger yet
	}
}

/** Parsed lines of a ledger; a torn or foreign line is skipped (as the store's reader does). */
function parsedLines(text: string): Line[] {
	const out: Line[] = [];
	for (const raw of text.split("\n")) {
		if (raw.trim().length === 0) continue;
		try {
			const v: unknown = JSON.parse(raw);
			if (isLine(v)) out.push(v);
		} catch {
			// torn line
		}
	}
	return out;
}

/**
 * The ledger without the lines `drop` selects; every other line, torn ones included, is kept byte for byte. The text
 * ends with a line break, so a torn last line (a crash in the middle of an append) cannot swallow the record that
 * the next append puts behind it.
 */
function withoutLines(text: string, drop: (line: Line) => boolean): string {
	const kept = text
		.split("\n")
		.filter((raw) => {
			if (raw.trim().length === 0) return true;
			try {
				const v: unknown = JSON.parse(raw);
				return !(isLine(v) && drop(v));
			} catch {
				return true;
			}
		})
		.join("\n");
	return kept.length > 0 && !kept.endsWith("\n") ? `${kept}\n` : kept;
}

// ─── the reset ───────────────────────────────────────────────────────────────

export interface AnkiResetPlan {
	/** Every card id that ever came from an Anki import (live or removed). */
	ankiCardIds: ReadonlySet<string>;
	/** The live Anki-imported cards, as they stand now. */
	ankiCards: readonly StudyCard[];
	/** Their reviews (undo lines included). */
	ankiReviews: readonly StudyReview[];
	/** Courses that go: they held Anki cards only. */
	dropCourses: readonly StudyCourse[];
	/** Courses that held Anki cards only but stay, because the owner set topics or a vault link on them. */
	keptCourses: readonly { course: StudyCourse; why: string }[];
	/** What stays: live cards / reviews of other origins. */
	keptCards: number;
	keptReviews: number;
}

/** Read the ledgers and work out what a reset removes. Changes nothing. */
export function planAnkiReset(files: StudyFiles): AnkiResetPlan {
	const store = createStudyStore(files);
	const ids = new Set<string>();
	for (const line of parsedLines(readText(files.cards))) {
		if (typeof line.id === "string" && isLine(line.origin) && line.origin.kind === "anki-import") ids.add(line.id);
	}
	const cards = store.readCards();
	const ankiCards = cards.filter((c) => ids.has(c.id));
	const others = cards.filter((c) => !ids.has(c.id));
	const reviews = store.readReviews();
	const ankiReviews = reviews.filter((r) => ids.has(r.cardId));

	const dropCourses: StudyCourse[] = [];
	const keptCourses: { course: StudyCourse; why: string }[] = [];
	for (const course of store.readCourses()) {
		const hadAnki = ankiCards.some((c) => c.courseId === course.id);
		if (!hadAnki || others.some((c) => c.courseId === course.id)) continue;
		const extras = [
			course.topics && course.topics.length > 0 ? "topics" : null,
			course.strictTopics !== undefined ? "topic setting" : null,
			course.vaultKey !== undefined ? "vault link" : null,
		].filter((x): x is string => x !== null);
		if (extras.length > 0) keptCourses.push({ course, why: `has ${extras.join(" and ")} set` });
		else dropCourses.push(course);
	}
	return {
		ankiCardIds: ids,
		ankiCards,
		ankiReviews,
		dropCourses,
		keptCourses,
		keptCards: others.length,
		keptReviews: reviews.length - ankiReviews.length,
	};
}

/**
 * Back the three ledgers up into `backupDir` (which must be empty or new), then rewrite them without the Anki
 * cards. Returns the plan it carried out (worked out again from the files, so it is never stale).
 */
export function applyAnkiReset(files: StudyFiles, backupDir: string): AnkiResetPlan {
	const plan = planAnkiReset(files);
	const dropCourseIds = new Set(plan.dropCourses.map((c) => c.id));
	const names = ["cards", "reviews", "courses"] as const;

	const texts = names.map((n) => readText(files[n]));
	const next = [
		withoutLines(texts[0]!, (l) => typeof l.id === "string" && plan.ankiCardIds.has(l.id)),
		withoutLines(texts[1]!, (l) => typeof l.cardId === "string" && plan.ankiCardIds.has(l.cardId)),
		withoutLines(texts[2]!, (l) => typeof l.id === "string" && dropCourseIds.has(l.id)),
	];

	if (fs.existsSync(backupDir) && fs.readdirSync(backupDir).length > 0) {
		throw new Error(`backup folder is not empty: ${backupDir}`);
	}
	fs.mkdirSync(backupDir, { recursive: true });
	names.forEach((n, i) => {
		if (fs.existsSync(files[n])) fs.copyFileSync(files[n], path.join(backupDir, `${n}.jsonl`));
		// the copy must be the file itself, or the reset does not start
		if (fs.existsSync(files[n]) && fs.readFileSync(path.join(backupDir, `${n}.jsonl`), "utf-8") !== texts[i]) {
			throw new Error(`backup of ${n}.jsonl does not match the ledger; nothing was changed`);
		}
	});

	const written: number[] = [];
	try {
		names.forEach((n, i) => {
			if (next[i] === texts[i]) return;
			const tmp = path.join(path.dirname(files[n]), `.${path.basename(files[n])}.${process.pid}.tmp`);
			try {
				fs.writeFileSync(tmp, next[i]!, "utf-8");
				fs.renameSync(tmp, files[n]);
			} catch (e) {
				fs.rmSync(tmp, { force: true });
				throw e;
			}
			written.push(i);
		});
	} catch (e) {
		for (const i of written) fs.writeFileSync(files[names[i]!], texts[i]!, "utf-8");
		throw e;
	}
	return plan;
}

/** Is the desktop app running on this data folder? Electron keeps `SingletonLock -> host-<pid>` beside `data/`. */
export function appIsRunning(dataDir: string): boolean {
	let target: string;
	try {
		target = fs.readlinkSync(path.join(path.dirname(path.resolve(dataDir)), "SingletonLock"));
	} catch {
		return false;
	}
	const pid = Number(/-(\d+)$/.exec(target)?.[1]);
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM"; // alive, but not ours
	}
}

// ─── the new plan ────────────────────────────────────────────────────────────

/** `--skip "Tests"`: leave the deck and everything below it out. `--merge "Anatomy::Muscles=Anatomy"`: that deck tree
 *  goes into the course `Anatomy`, the levels below the prefix become the topic. Prefixes are whole levels, joined by `::`. */
export interface DeckRule {
	prefix: string[];
	/** null = skip; else the course the tree is merged into. */
	course: string | null;
}

export function parseRule(kind: "skip" | "merge", text: string): DeckRule {
	const split = (s: string): string[] => s.split("::").map((x) => x.trim());
	const bad = (why: string) => new Error(`--${kind} "${text}": ${why}`);
	if (kind === "skip") {
		const prefix = split(text);
		if (prefix.some((x) => x.length === 0)) throw bad("a deck name is empty");
		return { prefix, course: null };
	}
	const eq = text.lastIndexOf("=");
	if (eq < 0) throw bad('expected "<deck prefix>=<course name>"');
	const prefix = split(text.slice(0, eq));
	const course = text.slice(eq + 1).trim();
	if (prefix.some((x) => x.length === 0) || course.length === 0) throw bad("a deck or course name is empty");
	return { prefix, course };
}

const startsWith = (levels: readonly string[], prefix: readonly string[]): boolean =>
	prefix.length <= levels.length && prefix.every((p, i) => levels[i] === p);

/** The `retarget` hook for suggestPlan; `hits` counts, per rule, the decks it caught (a rule that catches none is a typo). */
export function retargetFor(rules: readonly DeckRule[]): {
	retarget: (levels: readonly string[], placed: DeckPlacement) => DeckPlacement | null;
	hits: number[];
} {
	const hits = rules.map(() => 0);
	const retarget = (levels: readonly string[], placed: DeckPlacement): DeckPlacement | null => {
		const i = rules.findIndex((r) => startsWith(levels, r.prefix));
		if (i < 0) return placed;
		hits[i] = (hits[i] ?? 0) + 1;
		const rule = rules[i]!;
		if (rule.course === null) return null;
		const topic = levels.slice(rule.prefix.length).join("::");
		return topic.length > 0 ? { course: rule.course, topic } : { course: rule.course };
	};
	return { retarget, hits };
}

// ─── the whole run ───────────────────────────────────────────────────────────

export interface ResetImportOptions {
	dataDir: string;
	collection: string;
	subjectLevel: number;
	rules: readonly DeckRule[];
	/** false = look only (the default of the command line). */
	apply: boolean;
	/** Where the ledger copy goes on apply. */
	backupDir: string;
	now?: Date;
}

export interface CourseSummary {
	id: string;
	name: string;
	deadline?: string;
	bufferDays: number;
	newPerDay?: number;
	cards: number;
	/** Cards of the course that sit in no topic. */
	noTopic: number;
	topics: { name: string; cards: number }[];
}

export interface ResetImportReport {
	applied: boolean;
	/** What the new import brings. */
	courses: CourseSummary[];
	skippedDecks: { name: string; cards: number }[];
	hints: string[];
	/** What the reset removes (and what stays). */
	reset: { cards: number; reviews: number; dropCourses: string[]; keptCourses: string[]; keptCards: number; keptReviews: number };
	/** What the owner loses by starting over, beyond the structure. */
	lost: {
		/** Reviews of cards that stay, that are not in Anki's history (made in Learnbox only, or undo lines). */
		reviewsOnlyInLearnbox: number;
		/** Reviews of cards the new import leaves out. */
		reviewsOfLeftOutCards: number;
		/** Imported cards that are no longer in the collection (deleted or not importable now). */
		cardsGoneFromAnki: number;
		/** Cards that differ from what the import produces now, by what differs. */
		changedCards: { fields: number; tags: number; core: number; kind: number; suspended: number };
	};
	import: { cards: number; reviews: number; skippedCards: number };
	backupDir?: string;
	outcome?: ImportOutcome;
}

const sameTags = (a: readonly string[], b: readonly string[]) => [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

/** Look at the reset and the new import (`apply: false`) or carry both out. */
export function runResetImport(o: ResetImportOptions): ResetImportReport {
	const now = o.now ?? new Date();
	const files: StudyFiles = {
		courses: path.join(o.dataDir, "study", "courses.jsonl"),
		cards: path.join(o.dataDir, "study", "cards.jsonl"),
		reviews: path.join(o.dataDir, "study", "reviews.jsonl"),
	};
	if (!fs.statSync(o.dataDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`data folder not found: ${o.dataDir}`);
	if (path.extname(o.collection).toLowerCase() !== ".anki2" || !fs.statSync(o.collection, { throwIfNoEntry: false })?.isFile()) {
		throw new Error(`not an Anki collection file: ${o.collection}`);
	}

	const col = readAnkiCollection(o.collection);
	const { retarget, hits } = retargetFor(o.rules);
	const suggested = suggestPlan(col, now, { subjectLevel: o.subjectLevel, retarget });
	const dead = o.rules.filter((_, i) => hits[i] === 0);
	if (dead.length > 0) {
		throw new Error(`no deck matches: ${dead.map((r) => `${r.prefix.join("::")}`).join(", ")} (check the spelling)`);
	}

	const reset = planAnkiReset(files);
	const keptIds = new Set(
		createStudyStore(files)
			.readCourses()
			.map((c) => c.id)
			.filter((id) => !reset.dropCourses.some((c) => c.id === id)),
	);
	const plan: ImportPlan = parseImportPlan({ courses: suggested.courses, decks: suggested.decks }, keptIds, now);
	const mapped = mapCollection(col, plan);

	// what the owner would lose
	const fresh = new Map(mapped.cards.map((c) => [c.id, c]));
	const freshReviewKeys = new Set(mapped.reviews.map((r) => `${r.cardId}|${r.at}`));
	const changed = { fields: 0, tags: 0, core: 0, kind: 0, suspended: 0 };
	let gone = 0;
	for (const old of reset.ankiCards) {
		const now_ = fresh.get(old.id);
		if (!now_) {
			gone++;
			continue;
		}
		if (JSON.stringify(old.fields) !== JSON.stringify(now_.fields)) changed.fields++;
		if (!sameTags(old.tags, now_.tags)) changed.tags++;
		if (old.core !== now_.core) changed.core++;
		if (old.kind !== now_.kind) changed.kind++;
		if ((old.suspended ?? false) !== (now_.suspended ?? false)) changed.suspended++;
	}
	let reviewsOnlyInLearnbox = 0;
	let reviewsOfLeftOutCards = 0;
	for (const r of reset.ankiReviews) {
		if (freshReviewKeys.has(`${r.cardId}|${r.at}`)) continue;
		if (fresh.has(r.cardId)) reviewsOnlyInLearnbox++;
		else reviewsOfLeftOutCards++;
	}

	// what the import brings
	const byCourse = new Map<string, Map<string, number>>();
	for (const c of mapped.cards) {
		const topics = byCourse.get(c.courseId) ?? new Map<string, number>();
		const t = c.topic ?? "";
		topics.set(t, (topics.get(t) ?? 0) + 1);
		byCourse.set(c.courseId, topics);
	}
	const courses: CourseSummary[] = plan.courses
		.filter((c) => byCourse.has(c.id))
		.map((c) => {
			const topics = byCourse.get(c.id)!;
			return {
				id: c.id,
				name: c.name,
				...(c.deadline ? { deadline: c.deadline } : {}),
				bufferDays: c.bufferDays,
				...(c.newPerDay ? { newPerDay: c.newPerDay } : {}),
				cards: [...topics.values()].reduce((s, n) => s + n, 0),
				noTopic: topics.get("") ?? 0,
				topics: [...topics.entries()]
					.filter(([t]) => t !== "")
					.map(([name, cards]) => ({ name, cards }))
					.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
	const skippedDecks = inspectCollection(col)
		.decks.filter((d) => plan.decks[String(d.id)] === null || plan.decks[String(d.id)] === undefined)
		.map((d) => ({ name: d.name, cards: d.cards }));
	const hints = [...suggested.hints];
	for (const c of plan.courses) {
		if (keptIds.has(c.id)) hints.push(`${c.name}: a course with this id already exists and stays as it is (its deadline is not changed).`);
	}
	const skippedCards = Object.values(mapped.report.skippedCards.unsupportedNoteType).reduce((s, n) => s + n, 0) + mapped.report.skippedCards.noteMissing;

	const report: ResetImportReport = {
		applied: false,
		courses,
		skippedDecks,
		hints,
		reset: {
			cards: reset.ankiCards.length,
			reviews: reset.ankiReviews.length,
			dropCourses: reset.dropCourses.map((c) => c.name),
			keptCourses: reset.keptCourses.map((k) => `${k.course.name} (${k.why})`),
			keptCards: reset.keptCards,
			keptReviews: reset.keptReviews,
		},
		lost: { reviewsOnlyInLearnbox, reviewsOfLeftOutCards, cardsGoneFromAnki: gone, changedCards: changed },
		import: { cards: mapped.cards.length, reviews: mapped.reviews.length, skippedCards },
	};
	if (!o.apply) return report;

	if (appIsRunning(o.dataDir)) throw new Error("Learnbox 2.0 is running on this data folder; quit it first");
	applyAnkiReset(files, o.backupDir);
	const store = createStudyStore(files);
	const outcome = runAnkiImport(o.collection, plan, { store, mediaDest: path.join(o.dataDir, "study", "media") });

	// the ledgers must now hold exactly what the import produced, plus what stayed
	const live = store.readCards();
	const liveAnki = live.filter((c) => c.origin.kind === "anki-import").length;
	const liveAnkiReviews = store.readReviews().filter((r) => r.cardId.startsWith("anki_")).length;
	if (liveAnki !== mapped.cards.length || live.length !== mapped.cards.length + reset.keptCards || liveAnkiReviews !== mapped.reviews.length) {
		throw new Error(
			`check failed after the import (cards ${liveAnki}/${mapped.cards.length}, reviews ${liveAnkiReviews}/${mapped.reviews.length}); the ledgers before the reset are in ${o.backupDir}`,
		);
	}
	return { ...report, applied: true, backupDir: o.backupDir, outcome };
}

/** The report as text for the terminal. */
export function formatReport(r: ResetImportReport): string {
	const out: string[] = [];
	out.push(r.applied ? "DONE — the Anki cards were reset and imported again." : "DRY RUN — nothing was changed.");
	out.push("");
	out.push("New structure:");
	for (const c of r.courses) {
		const meta = [
			c.deadline ? `deadline ${c.deadline}` : "no deadline",
			`buffer ${c.bufferDays}`,
			c.newPerDay ? `${c.newPerDay} new/day` : "new/day automatic",
		].join(", ");
		out.push(`  ${c.name}  (${meta})  — ${c.cards} cards`);
		if (c.noTopic > 0 && c.topics.length > 0) out.push(`      (no topic)  ${c.noTopic}`);
		for (const t of c.topics) out.push(`      ${t.name}  ${t.cards}`);
	}
	if (r.skippedDecks.length > 0) {
		out.push("");
		out.push("Not imported:");
		for (const d of r.skippedDecks) out.push(`  ${d.name}  ${d.cards}`);
	}
	out.push("");
	out.push(`Removed first: ${r.reset.cards} Anki cards, ${r.reset.reviews} reviews, courses: ${r.reset.dropCourses.join(", ") || "none"}.`);
	out.push(`Stays: ${r.reset.keptCards} other cards, ${r.reset.keptReviews} other reviews${r.reset.keptCourses.length ? `; courses kept: ${r.reset.keptCourses.join(", ")}` : ""}.`);
	out.push(`Imported: ${r.import.cards} cards, ${r.import.reviews} reviews (${r.import.skippedCards} cards not importable).`);
	const ch = r.lost.changedCards;
	out.push("");
	out.push("Lost by starting over:");
	out.push(`  reviews made in Learnbox only (not in Anki's history): ${r.lost.reviewsOnlyInLearnbox}`);
	out.push(`  reviews of cards the new import leaves out: ${r.lost.reviewsOfLeftOutCards}`);
	out.push(`  cards no longer in the collection: ${r.lost.cardsGoneFromAnki}`);
	out.push(`  cards that differ from a fresh import — text: ${ch.fields}, tags: ${ch.tags}, core flag: ${ch.core}, kind: ${ch.kind}, paused: ${ch.suspended}`);
	for (const h of r.hints) out.push(`  hint: ${h}`);
	if (r.backupDir) out.push("", `Ledger backup: ${r.backupDir}`);
	return out.join("\n");
}

// ─── command line ────────────────────────────────────────────────────────────

export class ResetUsageError extends Error {}

export function parseResetArgs(argv: readonly string[], now: Date = new Date()): ResetImportOptions {
	let dataDir: string | undefined;
	let collection: string | undefined;
	let backupDir: string | undefined;
	let subjectLevel = 1;
	let apply = false;
	const rules: DeckRule[] = [];
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!;
		if (flag === "--apply") {
			apply = true;
			continue;
		}
		const value = argv[++i];
		if (value === undefined || value.startsWith("--")) throw new ResetUsageError(`${flag} needs a value`);
		try {
			if (flag === "--data-dir") dataDir = path.resolve(value);
			else if (flag === "--collection") collection = path.resolve(value);
			else if (flag === "--backup-dir") backupDir = path.resolve(value);
			else if (flag === "--subject-level") {
				if (!/^\d+$/.test(value)) throw new ResetUsageError("--subject-level must be a whole number");
				subjectLevel = Number(value);
			} else if (flag === "--skip") rules.push(parseRule("skip", value));
			else if (flag === "--merge") rules.push(parseRule("merge", value));
			else throw new ResetUsageError(`unknown option: ${flag}`);
		} catch (e) {
			throw e instanceof ResetUsageError ? e : new ResetUsageError(e instanceof Error ? e.message : String(e));
		}
	}
	if (dataDir === undefined) throw new ResetUsageError("--data-dir is required");
	if (collection === undefined) throw new ResetUsageError("--collection is required");
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
	return {
		dataDir,
		collection,
		subjectLevel,
		rules,
		apply,
		backupDir: backupDir ?? path.join(path.dirname(dataDir), `${path.basename(dataDir)}-backup-vor-neuimport-${stamp}`, "study"),
		now,
	};
}
