/**
 * The graph, seen through one course (Learnbox 2.0, 2026-11, Slice 9)
 *
 * A course's part of the knowledge graph is the propositions its lessons touched
 * (`nodeSessions`: node → chats that touched it) and the arguments among them. Pure: the view
 * hides everything outside this set through the renderer's visibility channel; nothing is
 * stored or recomputed on the server.
 */

import type { GraphSnapshot } from "./contracts/graph.ts";

/**
 * The node ids to show for a set of lessons: every proposition one of them touched, plus the
 * implication node of each chain whose premises and conclusion are all shown (its arrows would
 * dangle otherwise).
 */
export function courseNodeIds(
	snapshot: Pick<GraphSnapshot, "propositions" | "nodeSessions" | "chains">,
	chatIds: ReadonlySet<string>,
): Set<string> {
	const keep = new Set<string>();
	for (const p of snapshot.propositions) {
		if ((snapshot.nodeSessions[p.id] ?? []).some((id) => chatIds.has(id))) keep.add(p.id);
	}
	for (const chain of snapshot.chains) {
		if (keep.has(chain.conclusion) && chain.premises.every((p) => keep.has(p))) keep.add(chain.id);
	}
	return keep;
}
