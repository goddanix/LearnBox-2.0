import { StudyView } from "@/components/study/study-view";

export const dynamic = "force-dynamic";

/**
 * The review screen: pick a course, then learn it (one course per session). `?course=<id>` goes
 * straight into that course, `&card=<id>` opens that card first — the way back from a lesson to
 * the flashcards it started from (Learnbox 2.0, Slice 9).
 */
export default async function StudyPage({ searchParams }: { searchParams: Promise<{ course?: string; card?: string }> }) {
	const { course, card } = await searchParams;
	return <StudyView initialCourseId={course} initialCardId={course ? card : undefined} />;
}
