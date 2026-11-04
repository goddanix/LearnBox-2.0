"""Regenerates tests/fixtures/medanki-card-prompts.json from MedAnki's own prompt code.

Run:  PYTHONDONTWRITEBYTECODE=1 python3 tests/fixtures/gen-medanki-card-prompts.py [path/to/MedAnki/medanki]

MedAnki's modules are executed from their source text only (nothing is imported or written into the MedAnki
folder). tests/card-prompts.test.ts compares the TypeScript prompts with this output, so a copy error in the
verbatim German texts cannot slip in.
"""
import ast
import json
import sys
from pathlib import Path
from types import SimpleNamespace

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / "Desktop/CLAUDE/MedAnki/medanki")
OUT = Path(__file__).with_name("medanki-card-prompts.json")


def run(name: str, namespace: dict, drop: tuple[str, ...] = ()) -> dict:
    text = (SRC / name).read_text(encoding="utf-8")
    for line in drop:
        text = text.replace(line, "")
    namespace.setdefault("__file__", str(SRC / name))
    exec(compile(text, name, "exec"), namespace)
    return namespace


def pick(name: str, wanted: set[str], namespace: dict) -> dict:
    """Only the named top-level assignments / functions of a module (the rest imports MedAnki internals)."""
    tree = ast.parse((SRC / name).read_text(encoding="utf-8"))
    keep = []
    for node in tree.body:
        targets = [t.id for t in getattr(node, "targets", []) if isinstance(t, ast.Name)]
        if (isinstance(node, ast.FunctionDef) and node.name in wanted) or any(t in wanted for t in targets):
            keep.append(node)
    exec(compile(ast.Module(body=keep, type_ignores=[]), name, "exec"), namespace)
    return namespace


config = run("config.py", {})
prompts = run("prompts.py", {"config": SimpleNamespace(**{k: v for k, v in config.items() if k.isupper()})}, drop=("from . import config\n",))
focus = run("focus.py", {})
courses = pick("courses.py", {"PRAKTIKUM_HINT", "kind_hint"}, {})
glossary = pick("glossary.py", {"format_hint"}, {})

# ─── sample layouts (TS form; converted to MedAnki's snake_case for the Python side) ───


def line(i, text, bbox, **kw):
    return {"id": i, "text": text, "bbox": bbox, "size": 10, "src": "pdf", "bold": False, "italic": False, "underline": False, "inFigure": False, **kw}


LONG = "Der Rückstau von Blut vor dem linken Herzen führt zu einem Lungenödem " * 8
LAYOUTS = {
    "full": {
        "lines": [
            line("L1", "Herzinsuffizienz", [0.0625, 0.05, 0.5, 0.0875], bold=True),
            line("L2", LONG, [0.05, 0.1, 0.95, 0.2]),
            line("L3", "Aorta", [0.2, 0.5, 0.3, 0.53], inFigure=True, italic=True, underline=True),
            line("O1", "scan text", [0.1875, 0.6, 0.3125, 0.64], src="ocr"),
            line("L4", "ein zwei drei vier fünf sechs sieben acht", [0.05, 0.7, 0.9, 0.73]),
            line("G1", "Aorta", [0.7, 0.5, 0.8, 0.53], src="legend", marker="1", legend="LG1"),
            line("G2", "Rot", [0.7, 0.56, 0.8, 0.59], src="legend", marker="■", legend="LG2"),
        ],
        "figures": [
            {"id": "F1", "kind": "raster", "bbox": [0.05, 0.3, 0.95, 0.8], "legends": ["LG1", "LG2"]},
            {"id": "F2", "kind": "vector", "bbox": [0.0005, 0.0015, 0.0025, 0.0035]},
        ],
        "legends": [
            {"id": "LG1", "kind": "numbered", "figure": "F1", "entries": ["G1", "G9"], "markersInFigure": 2},
            {"id": "LG2", "kind": "swatch", "figure": "F1", "entries": ["G2"], "markersInFigure": 0},
        ],
    },
    "empty": {"lines": [], "figures": [], "legends": []},
    "long": {"lines": [line(f"L{n}", f"Zeile {n} " + "x" * (n % 7), [0.1, 0.1, 0.5, 0.12]) for n in range(1, 266)], "figures": [], "legends": []},
}


def snake(layout: dict) -> dict:
    return {
        "title": "",
        "chars": 0,
        "lines": [
            {**{k: v for k, v in ln.items() if k != "inFigure"}, "in_figure": ln["inFigure"]} for ln in layout["lines"]
        ],
        "figures": layout["figures"],
        "legends": [{**{k: v for k, v in lg.items() if k != "markersInFigure"}, "markers_in_figure": lg["markersInFigure"]} for lg in layout["legends"]],
    }


DENSITY = {"brief": "knapp", "normal": "normal", "thorough": "ausfuehrlich", "concept": "konzept"}
SYSTEMS = [("normal", "en", False, False), ("brief", "de", True, False), ("thorough", "auto", False, True), ("concept", "en", True, True)]
TERMS = [{"canonical": "Troponin T", "variants": ["Troponin-T", "TnT"]}, {"canonical": "Aorta", "variants": ["Hauptschlagader"]}]
BRIEF = [
    {"id": "p003-c02", "type": "basic", "warnings": ["No evidence quote given"], "front": "Wohin staut sich das Blut?", "back": "In die Lunge – „äöü“"},
    {"id": "p003-c03", "type": "image_occlusion", "warnings": ["x"], "header": "Name it", "label": "Aorta"},
]

DEDUPE_BRIEF = [
    {"id": "p003-c02", "type": "basic", "front": "Wo liegt die Aorta?", "back": "Hinter dem Sternum"},
    {"id": "p007-c05", "type": "image_occlusion", "header": "Benenne die markierte Struktur", "label": "Aorta"},
]
DEDUPE_PAIRS = [["p003-c02", "p007-c05"], ["p010-c01", "p010-c03"]]

fixture = {
    "systems": [
        {"density": d, "language": lang, "latin": latin, "atlas": atlas, "text": prompts["system_prompt"](DENSITY[d], lang, latin, atlas)}
        for d, lang, latin, atlas in SYSTEMS
    ],
    "vocab": [{"lang": lang, "text": prompts["vocab_system"](lang)} for lang in ("Tschechisch", "Polish")],
    "glossarySystem": {"plain": prompts["glossary_system"](False), "latin": prompts["glossary_system"](True)},
    "glossaryPrompt": prompts["glossary_prompt"]("Anatomie Vorlesung 3.pdf", "=== Seite 1 ===\nHerz\n\n=== Seite 4 ===\n★ Aorta"),
    "glossaryHint": {"terms": TERMS, "text": glossary["format_hint"](TERMS), "empty": glossary["format_hint"]([])},
    "focus": {
        "topics": ["Herzinsuffizienz", "Aorta"],
        "soft": focus["hint"](["Herzinsuffizienz", "Aorta"], False),
        "strict": focus["hint"](["Herzinsuffizienz", "Aorta"], True),
        "none": focus["hint"]([], True),
        "clean": {
            "input": " Herz;  Aorta,\nherz\n  -Niere: ;" + ";".join(f"T{i}" for i in range(50)),
            "output": focus["clean_topics"](" Herz;  Aorta,\nherz\n  -Niere: ;" + ";".join(f"T{i}" for i in range(50))),
        },
    },
    "kindHint": courses["kind_hint"]("praktikum"),
    "criticSystem": prompts["CRITIC_SYSTEM"],
    "criticPrompt": {"pageText": "[L1] Seite\n[L2] Text", "cards": BRIEF, "text": prompts["critic_prompt"]("[L1] Seite\n[L2] Text", BRIEF)},
    "pages": [
        {
            "name": name,
            "layout": layout,
            "text": prompts["build_page_prompt"]("Kardio.pdf", 3, 12, "pages/p003.png", snake(layout), "Vorher", "Nachher"),
        }
        for name, layout in LAYOUTS.items()
    ],
    "dedupeSystem": prompts["DEDUPE_SYSTEM"],
    "dedupePrompt": {"cards": DEDUPE_BRIEF, "pairs": DEDUPE_PAIRS, "text": prompts["dedupe_prompt"](DEDUPE_BRIEF, [tuple(p) for p in DEDUPE_PAIRS])},
    "repairSuffix": prompts["REPAIR_SUFFIX"].format(error="JSON-Fehler: x"),
}
OUT.write_text(json.dumps(fixture, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
