/**
 * THE CORE PUBLIC API — the only module the shell (app/, components/) may
 * import. Everything exported here is browser-safe: pure logic + types,
 * no node builtins, no fs, no network.
 *
 * Server-side surfaces (chat streaming, store reads) live behind
 * src/server's barrel instead — the import law (eslint.config.mjs):
 *
 *   components/**  →  "@/src/core"        (this barrel, ONLY)
 *   app/**         →  "@/src/core" + "@/src/server"
 *
 * Server-only core modules (core/graph.ts emission/derivation) are pure
 * but need storage ports passed in by a server caller, so they are
 * deliberately NOT re-exported here — the server imports them directly.
 * The storage PORT TYPES are types-only and browser-safe, hence re-exported.
 */

export * from "./contracts.ts";
export * from "./ports.ts";
export * from "./chains.ts";
export * from "./render-settings.ts";

export * from "./question-core.ts";
// Drawing and dragging boxes on a page picture (the Create focus screen).
export * from "./box-edit.ts";
// Subjects: their topics, the drafts of a subject across PDFs, and how well it was remembered (Create).
export * from "./course-topics.ts";
export * from "./course-cards.ts";
export * from "./retention.ts";
// The audio summary of a course: the length of the script, the material, a script cut for the speech service (Create).
export * from "./audio-script.ts";
// A Range header (the player winds through an MP3).
export * from "./http-range.ts";
// The event bus (push architecture, 2026-10-02): vocabulary + emit/subscribe
// for every layer; the browser shell consumes the types + the runtime names
// through this barrel (shell law: pure core via @/src/core only).
export * from "./events.ts";
// clusters.ts (Louvain) is deliberately NOT re-exported: nothing in the
// shell runs community detection — the snapshot carries the partition
// from the server. Keeping it out keeps the heavy clustering deps out of the
// client bundle (verified 2026-09-13: chunks contained it while this
// line existed). Same logic as layout-settle.ts below.
export * from "./layout.ts";
export * from "./plan-tree.ts";
export * from "./phases.ts";
export * from "./pending.ts";
export * from "./prompt-segments.ts";
export * from "./math-delims.ts";
// Wave B (owner-approved 2026-09-26): the native record (LhMessage), the
// and the input-events contract — all
// pure logic, browser-safe.
export * from "./native-messages.ts";
export * from "./compaction.ts";
export * from "./input-events.ts";
// Wave D (owner-approved 2026-09-26): the client view model — the grouping
// canon (one continuous assistant document, step separators) ported from
// the deleted server projection to the client side. Pure, browser-safe.
export * from "./view.ts";
export * from "./tool-parts.ts";
export * from "./answer-presentation.ts";
export * from "./prices.ts";
export * from "./context-usage.ts";
export type { ChatGPTStatus, ChatGPTControlBridge } from "./contracts/chatgpt.ts";
export { NATIVE_SUBSCRIPTIONS } from "./contracts/subscriptions.ts";
export type { NativeSubscriptionProviderId, NativeSubscriptionLogicalId, NativeSubscriptionStatus, NativeSubscriptionSnapshot, NativeSubscriptionScope, NativeSubscriptionControlBridge, SubscriptionInteraction, SubscriptionPrompt } from "./contracts/subscriptions.ts";
export * from "./cost-summary.ts";
export * from "./fuzzy.ts";
export * from "./deadline.ts"; // study: deadline math (ported Deadline Scheduler)
export * from "./fsrs.ts"; // study: FSRS review-ledger fold
export * from "./study-queue.ts"; // study: next-card queue (Deadline Scheduler + StudyQueueOrder rules)
export * from "./study-render.ts"; // study: card → script-free HTML for the review screen
export * from "./study-engine.ts"; // study: the queue + answer + card faces over a StudyStore (shared by the Mac and the phone)
export * from "./study-link.ts"; // study ↔ lessons: weak spots, plain card faces, the study-context marker
export * from "./graph-course.ts"; // the graph seen through one course's lessons
export * from "./create.ts"; // create: model-answer parsing + draft rules (PDF → study material)
export * from "./mobile.ts"; // phone access: gateway route rules, pairing codes, Tailscale status
export * from "./phone-deck.ts"; // phone: cutting the deck on the Mac, reading it on the phone
export * from "./phone-sync.ts"; // phone: answers going back to the Mac (sync upload, backup file)
export * from "./memory-study-store.ts"; // study: the ledgers in memory (the phone's working copy, tests)
export * from "./lesson-cards.ts"; // create: cards from a lesson's statements (statements, drafts, adoption)
export * from "./anki-import.ts"; // study: pure Anki-row → study mapping
// settings.ts + settings-resolution.ts (settings-storage wave, 2026-09-19):
// the user-settings record's shape/sanitizer (pure) and its fully-resolved
// view. Browser-safe — the Wave-4 panel imports these directly.
export * from "./settings.ts";
// graph-deletion.ts (wave 6): the whole module is PURE but storage-port
// driven — the deletion RUNS server-side only. The shell needs exactly one
// two type-only things from it: the ChatDeleteMode union (the delete
// dialog's two-option design + the DELETE query param) and the stats
// shape its success line describes, hence this type-only re-export.
export type { ChatDeleteMode, ChatDeletionStats } from "./graph-deletion.ts";
export * from "./settings-resolution.ts";
export * from "./search.ts"; // search port (search wave, 2026-09-20)
export * from "./session-find.ts";
export * from "./session-navigation.ts";
// auth-keys.ts (auth-keys wave, 2026-09-19): the curated key catalog +
// shape rules + masking — pure, browser-safe (the auth page binds to the
// /api/keys routes built on it).
export * from "./auth-keys.ts";
// keyboard.ts: the shortcut registry + binding normalization (pure, browser-safe).
export * from "./keyboard.ts";
export * from "./coverage.ts";
// session-markdown.ts (2026-09-27 engine; first consumer 2026-10-06): the
// ONE session→markdown formatter — the extractor's view and the user-facing
// export share it. Pure, browser-safe.
export * from "./session-markdown.ts";
