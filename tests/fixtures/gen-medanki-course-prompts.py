"""Regenerates tests/fixtures/medanki-course-prompts.json from MedAnki's own subject / topic code.

Run:  PYTHONDONTWRITEBYTECODE=1 python3 tests/fixtures/gen-medanki-course-prompts.py [path/to/MedAnki/medanki]

MedAnki's modules are executed from their source text only (nothing is imported or written into the MedAnki
folder): the topic-list prompts (courses.py), the card-to-topic assignment (topic_assign.py) and the small pure
functions around them. tests/course-prompts.test.ts and tests/course-topics.test.ts compare the TypeScript
versions with this output, so a copy error in the verbatim German texts cannot slip in.
"""
import ast
import json
import re
import sys
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / "Desktop/CLAUDE/MedAnki/medanki")
OUT = Path(__file__).with_name("medanki-course-prompts.json")


def source(name: str) -> str:
    return (SRC / name).read_text(encoding="utf-8")


def pick(name: str, wanted: set[str], namespace: dict) -> dict:
    """Only the named top-level assignments / functions of a module (the rest imports MedAnki internals)."""
    tree = ast.parse(source(name))
    keep = []
    for node in tree.body:
        targets = [t.id for t in getattr(node, "targets", []) if isinstance(t, ast.Name)]
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            targets.append(node.target.id)
        if (isinstance(node, ast.FunctionDef) and node.name in wanted) or any(t in wanted for t in targets):
            keep.append(node)
    exec(compile(ast.Module(body=keep, type_ignores=[]), name, "exec"), namespace)
    return namespace


focus_ns: dict = {"re": re}
exec(compile(source("focus.py").replace("from __future__ import annotations\n", ""), "focus.py", "exec"), focus_ns)


class Focus:
    clean_topics = staticmethod(focus_ns["clean_topics"])


COURSES = pick(
    "courses.py",
    {
        "MAX_TEXT_LINE", "topics_from_text", "TOPICS_SYSTEM", "topics_prompt", "CONSOLIDATE_SYSTEM", "consolidate_prompt",
        "clean_proposal", "MAX_NEW_PER_UPLOAD", "MATCH_SYSTEM", "match_prompt", "parse_matches", "merge_topics", "clean_topics_list",
    },
    {"re": re, "focus": Focus},
)
ASSIGN = pick("topic_assign.py", {"BATCH", "SONSTIGES", "SYSTEM", "_card_text", "prompt", "parse"}, {"re": re})

TEXT = """Lernziele
- Herzinsuffizienz – Ursachen und Klinik
* Troponin
1. Aortenstenose: Befunde
2) EKG
a) Ab
b. Vorhofflimmern und Antikoagulation
•  Klappenfehler
Literatur zur Vorlesung: ein sehr langer Eintrag """ + "x" * 170 + """

herzinsuffizienz – ursachen und klinik
"""

PAGE_TOPICS = ["Kardio.pdf, S. 3: Herzinsuffizienz", "Kardio.pdf, S. 7: Aortenstenose"]
LABELS = [("Heart failure", 12), ("Aorta", 3)]
EXISTING = ["Heart valves", "Heart failure", "Rhythm"]
NEW = ["Mitral valve stenosis – causes", "Troponin", "Atrial fibrillation", "Pericarditis"]

MATCH_RAW = [
    {"matches": [{"new": 1, "existing": 1}, {"new": 2, "existing": 0}, {"new": 3, "existing": 3}, {"new": 4, "existing": 9}]},
    {"matches": [{"new": "1", "existing": "2"}, {"new": 7, "existing": 1}, "x", {"new": 2}, {"new": 3, "existing": None}]},
    {"matches": "nope"},
    "nope",
    {},
]
MERGE_CASES = [
    {"existing": EXISTING, "extracted": NEW, "matches": {1: 1, 3: 3}},
    {"existing": [], "extracted": ["A one", "a ONE", "B two"], "matches": {}},
    {"existing": ["X"], "extracted": [f"New topic {i}" for i in range(9)], "matches": {}},
    {"existing": ["Heart"], "extracted": ["heart", "Lung"], "matches": {}},
]
PROPOSAL_RAW = [
    [{"name": "Duodenum", "source": "liste"}, {"name": "duodenum", "source": "vorlesung"}, {"name": "Pankreas", "source": "VORLESUNG"},
     {"name": "  ", "source": "liste"}, "Colon", {"name": "Rectum", "source": "x"}, 5, None, {"source": "liste"}],
    "not a list",
    [{"name": f"Topic {i}", "source": "liste"} for i in range(50)],
]

CARDS = [
    {"type": "basic", "front": "What is the\nmost common cause of heart failure?", "back": "Coronary artery disease"},
    {"type": "cloze", "text": "The {{c1::aortic valve::valve}} has {{c2::three}} cusps."},
    {"type": "image_occlusion", "header": "Heart", "label": "Left atrium"},
    {"type": "basic", "front": "x" * 300, "back": "y"},
    {"type": "process", "front": "Steps of  ventricular filling", "back": "1. passive 2. atrial kick"},
]
KEYS = ["j1:p001-c01", "j1:p001-c02", "j2:p004-c01", "j2:p004-c02", "j3:p009-c01"]
ASSIGN_RAWS = [
    {"assignments": [{"id": "j1:p001-c01", "topic": 1}, {"id": "j1:p001-c02", "topic": "2"}, {"id": "j2:p004-c01", "topic": 0},
                      {"id": "j2:p004-c02", "topic": 9}, {"id": "zzz", "topic": 1}, "x", {"id": "j3:p009-c01", "topic": None}]},
    {"assignments": "no"},
    {},
]
ASSIGN_TOPICS = ["Heart failure", "Valves"]

fixture = {
    "topicsSystem": COURSES["TOPICS_SYSTEM"],
    "topicsPrompt": {"course": "Kardiologie", "text": "Herzinsuffizienz\nKlappen", "out": COURSES["topics_prompt"]("Kardiologie", "Herzinsuffizienz\nKlappen")},
    "consolidateSystem": COURSES["CONSOLIDATE_SYSTEM"],
    "consolidatePrompt": {
        "course": "Kardiologie", "list": EXISTING, "pages": PAGE_TOPICS, "labels": LABELS,
        "out": COURSES["consolidate_prompt"]("Kardiologie", EXISTING, PAGE_TOPICS, LABELS),
        "empty": COURSES["consolidate_prompt"]("Kardiologie", [], [], []),
    },
    "matchSystem": COURSES["MATCH_SYSTEM"].replace("{max_new}", str(COURSES["MAX_NEW_PER_UPLOAD"])),
    "matchPrompt": {"existing": EXISTING, "new": NEW, "out": COURSES["match_prompt"](EXISTING, NEW)},
    "topicsFromText": {"input": TEXT, "output": COURSES["topics_from_text"](TEXT)},
    "parseMatches": [
        {"raw": raw, "nExisting": 3, "nNew": 4, "out": {str(k): v for k, v in COURSES["parse_matches"](raw, 3, 4).items()}}
        for raw in MATCH_RAW
    ],
    "mergeTopics": [
        {
            "existing": c["existing"], "extracted": c["extracted"], "matches": {str(k): v for k, v in c["matches"].items()},
            "topics": COURSES["merge_topics"](c["existing"], c["extracted"], c["matches"])[0],
            "report": COURSES["merge_topics"](c["existing"], c["extracted"], c["matches"])[1],
        }
        for c in MERGE_CASES
    ],
    "cleanProposal": [{"raw": raw, "out": COURSES["clean_proposal"](raw)} for raw in PROPOSAL_RAW],
    "assignSystem": ASSIGN["SYSTEM"],
    "assignBatch": ASSIGN["BATCH"],
    "assignOther": ASSIGN["SONSTIGES"],
    "cardText": [{"card": c, "out": ASSIGN["_card_text"](c)} for c in CARDS],
    "assignPrompt": {
        "topics": ASSIGN_TOPICS,
        "keys": KEYS,
        "out": ASSIGN["prompt"](ASSIGN_TOPICS, list(zip(KEYS, CARDS))),
    },
    "assignParse": [{"raw": raw, "out": ASSIGN["parse"](raw, ASSIGN_TOPICS, set(KEYS))} for raw in ASSIGN_RAWS],
}
OUT.write_text(json.dumps(fixture, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
