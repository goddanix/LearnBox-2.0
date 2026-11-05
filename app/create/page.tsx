import { CreateView } from "@/components/create/create-view";

export const dynamic = "force-dynamic";

/**
 * The Create area: turn a library PDF into draft study material, then adopt it into a course. `?lesson=<chat id>`
 * (a lesson's "Make cards" button) or `?nodes=<id>,<id>` (nodes picked on the graph) open the form for cards from
 * those statements (Learnbox 2.0, Slice 9c).
 */
export default async function CreatePage({ searchParams }: { searchParams: Promise<{ lesson?: string; nodes?: string }> }) {
	const { lesson, nodes } = await searchParams;
	return <CreateView lesson={lesson} nodes={nodes ? nodes.split(",").filter(Boolean) : undefined} />;
}
