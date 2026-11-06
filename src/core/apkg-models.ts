/**
 * The four note types of the .apkg export — MedAnki's, VERBATIM (generated 2026-11-06 from
 * MedAnki/medanki/export.py: ids, names, fields, templates, CSS, LaTeX). Anki merges a package's note types by id, so a
 * deck exported here lands on the very note types the learner's Anki already has from MedAnki; change a template here and
 * Anki would ask to overwrite theirs. Do not "tidy" these strings.
 *
 * `req` (which fields a template needs to produce a card) was computed with genanki's own routine at generation time.
 */

import type { StudyCardKind } from "./contracts/study.ts";

export interface ApkgTemplate {
	name: string;
	qfmt: string;
	afmt: string;
}
export interface ApkgModel {
	id: number;
	name: string;
	/** Anki's notetype type: 0 = standard, 1 = cloze. */
	type: 0 | 1;
	fields: readonly string[];
	templates: readonly ApkgTemplate[];
	/** [template index, "all" | "any", field indexes] — as genanki writes it. */
	req: readonly (readonly [number, "all" | "any", readonly number[]])[];
}

export const LATEX_PRE = "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n";
export const LATEX_POST = "\\end{document}";

export const APKG_CSS = "\n.card { font-family: -apple-system, \"Helvetica Neue\", Arial, sans-serif; font-size: 20px; line-height: 1.4;\n        text-align: left; color: #1d1d1f; background: #fff; max-width: 760px; margin: 0 auto; padding: 8px; }\n.nightMode .card { color: #ececec; background: #1e1e1e; }\n.cloze { font-weight: bold; color: #1a6fd6; }\n.nightMode .cloze { color: #6cb0ff; }\n.latin-en { color: #6c7a89; font-style: italic; }\n.nightMode .latin-en { color: #9fb0c0; }\n.legend-mark { position: absolute; border: 3px solid #ff3b30; border-radius: 50%; box-shadow: 0 0 0 2px rgba(255, 59, 48, .35);\n               display: none; pointer-events: none; box-sizing: border-box; }\n.legend-mark.active { display: block; }\n.nightMode .legend-mark { border-color: #ff6961; box-shadow: 0 0 0 2px rgba(255, 105, 97, .35); }\n.header { font-weight: 600; margin-bottom: 8px; }\n.extra { margin-top: 12px; padding: 8px 10px; border-left: 3px solid #b0b8c4; font-size: 17px; opacity: .92; }\n.answer { margin-top: 10px; font-weight: 600; }\n.source { margin-top: 14px; font-size: 12px; color: #8a8f98; }\nimg { max-width: 100%; height: auto; }\nhr#answer { border: none; border-top: 1px solid #c9ced6; margin: 12px 0; }\n.mcq-opts { margin: 10px 0; }\n.mcq-opt { padding: 9px 12px; margin-bottom: 7px; border: 1.5px solid #c9ced6; border-radius: 9px; cursor: pointer; }\n.mcq-opt b { margin-right: 4px; }\n.mcq-opts.mcq-locked .mcq-opt { cursor: default; }\n.mcq-opt.mcq-selected { border-color: #1a6fd6; background: rgba(26, 111, 214, .08); }\n.mcq-opt.mcq-hit { border-color: #1f9d55; background: rgba(31, 157, 85, .14); }\n.mcq-opt.mcq-missed { border-color: #1f9d55; border-style: dashed; background: rgba(31, 157, 85, .05); }\n.mcq-opt.mcq-wrong { border-color: #c53030; background: rgba(197, 48, 48, .14); }\n.mcq-check { margin-top: 4px; padding: 8px 18px; border: none; border-radius: 8px; background: #1a6fd6; color: #fff; font-size: 16px; cursor: pointer; }\n.mcq-check:hover { opacity: .92; }\n.mcq-key-hint { opacity: .75; font-size: 13px; }\n.mcq-explanation { margin-top: 10px; }\n.nightMode .mcq-opt { border-color: #3a4048; }\n.nightMode .mcq-opt.mcq-selected { border-color: #6cb0ff; background: rgba(108, 176, 255, .12); }\n.nightMode .mcq-opt.mcq-hit { border-color: #46c27e; background: rgba(70, 194, 126, .18); }\n.nightMode .mcq-opt.mcq-missed { border-color: #46c27e; background: rgba(70, 194, 126, .08); }\n.nightMode .mcq-opt.mcq-wrong { border-color: #f08080; background: rgba(240, 128, 128, .18); }\n";

export const BASIC_MODEL: ApkgModel = {
	id: 1607392401,
	name: "MedAnki Basic",
	type: 0,
	fields: ["Front","Back","Extra","Source","Reverse"],
	templates: [
		{
			name: "Vorwärts",
			qfmt: "{{Front}}",
			afmt: "{{FrontSide}}<hr id=\"answer\">{{Back}}{{#Extra}}<div class=\"extra\">{{Extra}}</div>{{/Extra}}<div class=\"source\">{{Source}}</div>",
		},
		{
			name: "Rückwärts",
			qfmt: "{{#Reverse}}{{Back}}{{/Reverse}}",
			afmt: "{{FrontSide}}<hr id=\"answer\">{{Front}}{{#Extra}}<div class=\"extra\">{{Extra}}</div>{{/Extra}}<div class=\"source\">{{Source}}</div>",
		},
	],
	req: [[0,"all",[0]],[1,"all",[1,4]]],
};

export const CLOZE_MODEL: ApkgModel = {
	id: 1607392402,
	name: "MedAnki Cloze",
	type: 1,
	fields: ["Text","Extra","Source","LegendCloze"],
	templates: [
		{
			name: "Cloze",
			qfmt: "{{cloze:Text}}{{#LegendCloze}}<script>document.querySelectorAll(\".legend-gap\").forEach(function(el){ el.textContent = \"[...]\"; });</script>{{/LegendCloze}}{{#LegendCloze}}<script>(function(){document.querySelectorAll('body > .legend-mark').forEach(function(el){ el.remove(); });var cz = document.querySelector('.cloze[data-ordinal]'); if (!cz) return;var n = cz.getAttribute(\"data-ordinal\");var mark = document.querySelector('.legend-mark[data-n=\"' + n + '\"]');var img = document.querySelector(\"img\");if (!mark || !img) return;var box = (mark.getAttribute(\"data-box\") || \"\").split(\",\").map(Number);if (box.length !== 4) return;function place(){var r = img.getBoundingClientRect();if (!r.width || !r.height) return;document.body.appendChild(mark);mark.style.position = \"absolute\";mark.style.left = (r.left + window.scrollX + box[0] * r.width) + 'px';mark.style.top = (r.top + window.scrollY + box[1] * r.height) + 'px';mark.style.width = ((box[2] - box[0]) * r.width) + 'px';mark.style.height = ((box[3] - box[1]) * r.height) + 'px';mark.classList.add(\"active\");}place();if (!img.complete) { img.addEventListener('load', place, {once: true}); }})();</script>{{/LegendCloze}}",
			afmt: "{{cloze:Text}}{{#LegendCloze}}<script>document.querySelectorAll(\".legend-gap\").forEach(function(el){ if (!el.closest(\".cloze\")) el.textContent = \"[...]\"; });</script>{{/LegendCloze}}{{#LegendCloze}}<script>(function(){document.querySelectorAll('body > .legend-mark').forEach(function(el){ el.remove(); });var cz = document.querySelector('.cloze[data-ordinal]'); if (!cz) return;var n = cz.getAttribute(\"data-ordinal\");var mark = document.querySelector('.legend-mark[data-n=\"' + n + '\"]');var img = document.querySelector(\"img\");if (!mark || !img) return;var box = (mark.getAttribute(\"data-box\") || \"\").split(\",\").map(Number);if (box.length !== 4) return;function place(){var r = img.getBoundingClientRect();if (!r.width || !r.height) return;document.body.appendChild(mark);mark.style.position = \"absolute\";mark.style.left = (r.left + window.scrollX + box[0] * r.width) + 'px';mark.style.top = (r.top + window.scrollY + box[1] * r.height) + 'px';mark.style.width = ((box[2] - box[0]) * r.width) + 'px';mark.style.height = ((box[3] - box[1]) * r.height) + 'px';mark.classList.add(\"active\");}place();if (!img.complete) { img.addEventListener('load', place, {once: true}); }})();</script>{{/LegendCloze}}{{#Extra}}<div class=\"extra\">{{Extra}}</div>{{/Extra}}<div class=\"source\">{{Source}}</div>",
		},
	],
	req: [[0,"all",[0,1,2,3]]],
};

export const OCCLUSION_MODEL: ApkgModel = {
	id: 1607392403,
	name: "MedAnki Bildverdeckung",
	type: 0,
	fields: ["Header","QuestionImage","AnswerImage","Answer","Extra","Source"],
	templates: [
		{
			name: "Bildverdeckung",
			qfmt: "<div class=\"header\">{{Header}}</div>{{QuestionImage}}",
			afmt: "<div class=\"header\">{{Header}}</div>{{AnswerImage}}<hr id=\"answer\">{{#Answer}}<div class=\"answer\">{{Answer}}</div>{{/Answer}}{{#Extra}}<div class=\"extra\">{{Extra}}</div>{{/Extra}}<div class=\"source\">{{Source}}</div>",
		},
	],
	req: [[0,"any",[0,1]]],
};

export const MCQ_MODEL: ApkgModel = {
	id: 1607392404,
	name: "MedAnki MCQ",
	type: 0,
	fields: ["Question","OptionA","OptionB","OptionC","OptionD","Correct","Explanation","Source"],
	templates: [
		{
			name: "MC-Frage",
			qfmt: "<div class=\"header\">{{Question}}</div><div class=\"mcq-opts\" data-correct=\"{{Correct}}\"><div class=\"mcq-opt\" data-key=\"A\"><b>A.</b> {{OptionA}}</div><div class=\"mcq-opt\" data-key=\"B\"><b>B.</b> {{OptionB}}</div><div class=\"mcq-opt\" data-key=\"C\"><b>C.</b> {{OptionC}}</div><div class=\"mcq-opt\" data-key=\"D\"><b>D.</b> {{OptionD}}</div></div><button type=\"button\" class=\"mcq-check\">Prüfen <span class=\"mcq-key-hint\">(X)</span></button><script>(function(){var wrap = document.querySelector(\".mcq-opts\"); var btn = document.querySelector(\".mcq-check\");if (!wrap || !btn) return;try { localStorage.removeItem(\"medankiMcqSelected\"); } catch(e) {}wrap.querySelectorAll(\".mcq-opt\").forEach(function(o){o.addEventListener(\"click\", function(){if (wrap.classList.contains(\"mcq-locked\")) return;o.classList.toggle(\"mcq-selected\");});});function grade(){if (wrap.classList.contains(\"mcq-locked\")) return;var correct = (wrap.getAttribute(\"data-correct\") || \"\").replace(/[^A-D]/g, \"\").split(\"\");var picked = [];wrap.querySelectorAll(\".mcq-opt\").forEach(function(o){var isPicked = o.classList.contains(\"mcq-selected\");if (isPicked) picked.push(o.getAttribute(\"data-key\"));var isCorrect = correct.indexOf(o.getAttribute(\"data-key\")) !== -1;if (isCorrect && isPicked) o.classList.add(\"mcq-hit\");else if (isCorrect && !isPicked) o.classList.add(\"mcq-missed\");else if (!isCorrect && isPicked) o.classList.add(\"mcq-wrong\");});try { localStorage.setItem(\"medankiMcqSelected\", picked.join(\",\")); } catch(e) {}wrap.classList.add(\"mcq-locked\");btn.style.display = \"none\";setTimeout(function(){ if (typeof pycmd === \"function\") { pycmd(\"ans\"); } }, 400);}btn.addEventListener(\"click\", grade);document.addEventListener(\"keydown\", function(e){if (wrap.classList.contains(\"mcq-locked\")) return;if (e.key.toLowerCase() !== \"x\") return;e.preventDefault(); e.stopPropagation();grade();}, true);})();</script>",
			afmt: "<div class=\"header\">{{Question}}</div><div class=\"mcq-opts\" data-correct=\"{{Correct}}\"><div class=\"mcq-opt\" data-key=\"A\"><b>A.</b> {{OptionA}}</div><div class=\"mcq-opt\" data-key=\"B\"><b>B.</b> {{OptionB}}</div><div class=\"mcq-opt\" data-key=\"C\"><b>C.</b> {{OptionC}}</div><div class=\"mcq-opt\" data-key=\"D\"><b>D.</b> {{OptionD}}</div></div><script>(function(){var wrap = document.querySelector(\".mcq-opts\");if (!wrap) return;var correct = (wrap.getAttribute(\"data-correct\") || \"\").replace(/[^A-D]/g, \"\").split(\"\");var pickedStr = \"\";try { pickedStr = localStorage.getItem(\"medankiMcqSelected\") || \"\"; } catch(e) {}var picked = pickedStr ? pickedStr.split(\",\") : [];wrap.querySelectorAll(\".mcq-opt\").forEach(function(o){var isPicked = picked.indexOf(o.getAttribute(\"data-key\")) !== -1;var isCorrect = correct.indexOf(o.getAttribute(\"data-key\")) !== -1;if (isCorrect && isPicked) o.classList.add(\"mcq-hit\");else if (isCorrect && !isPicked) o.classList.add(\"mcq-missed\");else if (!isCorrect && isPicked) o.classList.add(\"mcq-wrong\");});wrap.classList.add(\"mcq-locked\");})();</script><hr id=\"answer\"><div class=\"answer\">Richtig: {{Correct}}</div><div class=\"mcq-explanation\">{{Explanation}}</div><div class=\"source\">{{Source}}</div>",
		},
	],
	req: [[0,"any",[0,1,2,3,4,5]]],
};

/** The note type each study card kind is exported as. */
export const MODEL_OF_KIND: Record<StudyCardKind, ApkgModel> = {
	basic: BASIC_MODEL,
	cloze: CLOZE_MODEL,
	occlusion: OCCLUSION_MODEL,
	mcq: MCQ_MODEL,
};

export const ALL_MODELS: readonly ApkgModel[] = [BASIC_MODEL, CLOZE_MODEL, OCCLUSION_MODEL, MCQ_MODEL];
