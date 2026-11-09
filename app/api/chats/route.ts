import { chainsForSelection, formatChainLine } from "@/src/core";
import { newGraphContextMessage, newLectureContextMessage, newStudyContextMessage, type GraphContextPick } from "@/src/core";
import { compactionInFlight, createChat, isTurnRunning, listChats, readSettingsRecord, resolveLectureSelection, StudyInputError, studyContextFor, stores, titleFromPrompt } from "@/src/server";
import type { ChatListItem, StudyContextData } from "@/src/core";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn marks the session busy
 *  (contracts.ts ChatListItem; the store can't see liveness, the route is
 *  the merge point). Owner, minimal-color round: background jobs NO LONGER
 *  count — the sidebar's Background agents section is their channel now
 *  (a running spinner per row would double-signal them), so busy means
 *  exactly "a teach turn is in flight". */
export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: compactionInFlight(c.id),
	}));
	return Response.json({ chats });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; kind?: unknown; graphContext?: unknown; lectureContext?: unknown; study?: unknown };
	const title = typeof body.title === "string" ? body.title : "";
	// Practice sessions (owner, 2026-10-04): kind "practice" marks the
	// record — the practice agent + its tools from turn 1, no extraction.
	const kind = body.kind === "practice" ? ("practice" as const) : undefined;
	// The study course (and the flashcards) a lesson starts for (Learnbox 2.0, Slice 9): the
	// request names ids, the context is read from the ledgers BEFORE the record exists, so a
	// stale course or card is a 4xx and never an orphan session. Teach sessions only.
	const studyRequest = !kind && typeof body.study === "object" && body.study !== null ? (body.study as { courseId?: unknown; cardIds?: unknown; topics?: unknown }) : undefined;
	let study: StudyContextData | undefined;
	if (studyRequest) {
		try {
			study = studyContextFor({ courseId: typeof studyRequest.courseId === "string" ? studyRequest.courseId : "", cardIds: studyRequest.cardIds, topics: studyRequest.topics });
		} catch (err) {
			if (err instanceof StudyInputError) return Response.json({ error: err.message }, { status: err.status });
			throw err;
		}
	}
	const chat = createChat(
		titleFromPrompt(title || "Untitled session"),
		kind,
		study ? { courseId: study.course.id, cardIds: study.cards.map((c) => c.id) } : undefined,
	);
	// PER-SESSION MODELS (owner, 2026-09-28): a session owns its model +
	// thinking level from birth — stamped verbatim from the STRONG slot,
	// the new-session default. From here the strong slot never reaches
	// this session again: in-session picks write the session's own record
	// (PUT /api/chats/:id/settings). No strong slot configured (fresh BYOK
	// boot) → no stamp; the turn gate's 503 models_not_configured envelope
	// refuses honestly until the setup flow fills the slot.
	const strong = readSettingsRecord()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
	// The session's map context (owner, 2026-10-04): the picked
	// propositions ride the CREATION — message[0] is a graph-context
	// marker (a separate custom message BEFORE the learner's first user
	// message), carrying the picks plus the reasoning chains among them.
	// The picks carry their own name/statement (what the learner saw at
	// pick time); the chains derive from the CURRENT graph snapshot.
	const rawPicks = (body.graphContext as { propositions?: unknown } | undefined)?.propositions;
	const picks: GraphContextPick[] = Array.isArray(rawPicks)
		? rawPicks
				.filter(
						(p): p is GraphContextPick =>
							typeof p === "object" &&
							p !== null &&
							typeof (p as GraphContextPick).id === "string" &&
							typeof (p as GraphContextPick).name === "string" &&
							typeof (p as GraphContextPick).statement === "string",
					)
					.slice(0, 64)
			: [];
	const markers = [];
	// The course context leads: it says what the session is for before anything is picked.
	if (study) markers.push(newStudyContextMessage(study));
	if (picks.length > 0) {
		const byId = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
		const pickedNodes = picks.map((p) => byId.get(p.id)).filter((n) => n !== undefined);
		const chainLines = chainsForSelection(pickedNodes, stores.graphStore.readChains()).map((c) =>
			formatChainLine(c, Object.fromEntries(byId)),
		);
		markers.push(newGraphContextMessage(picks, chainLines));
	}
	// The lecture pick (Learnbox, 2026-10): resolved against the stored
	// outlines — the request names ids and depths, never topic text — and
	// carried as a marker before the learner's first message, like the map pick.
	// Practice sessions work from the graph and take no lectures.
	if (!kind) {
		const lectures = resolveLectureSelection(body.lectureContext);
		if (lectures.length > 0) markers.push(newLectureContextMessage(lectures));
	}
	if (markers.length > 0) stores.chatStore.saveMessages(chat.id, markers);
	return Response.json({ id: chat.id, title: chat.title });
}
