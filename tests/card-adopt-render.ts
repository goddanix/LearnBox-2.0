/** Test helper: one side of a study card as the review screen renders it (media left as written). */
import type { StudyCard } from "../src/core/contracts/study.ts";
import { renderFace } from "../src/core/study-render.ts";

export const renderCard = (card: StudyCard, face: "front" | "back"): string => renderFace(card, face, (name) => `data:,${name}`).html;
