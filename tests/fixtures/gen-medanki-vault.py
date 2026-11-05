"""Regenerates tests/fixtures/medanki-vault.json from MedAnki's own Obsidian code.

Run:  PYTHONDONTWRITEBYTECODE=1 python3 tests/fixtures/gen-medanki-vault.py [path/to/MedAnki/medanki]

MedAnki's modules are executed from their source text only (nothing is imported from, or written into, the MedAnki
folder): vault.py (what lands in the vault and how an existing note is protected), notes_prompts.py (the prompts),
notes.py / topic_notes.py (the pure helpers around a topic note) and linker.py (the similarity and the related-topics
blocks). Every scenario runs in a temporary vault. tests/vault-*.test.ts, tests/topic-notes.test.ts and
tests/notes-prompts.test.ts compare the TypeScript versions with this output.
"""
import hashlib
import json
import re
import sys
import tempfile
import types
from pathlib import Path
from types import SimpleNamespace

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / "Desktop/CLAUDE/MedAnki/medanki")
OUT = Path(__file__).with_name("medanki-vault.json")


def load(name: str, **inject):
    """A MedAnki module from its source text, its `from . import …` line replaced by what the caller injects."""
    src = (SRC / name).read_text(encoding="utf-8").replace("from __future__ import annotations\n", "")
    src = re.sub(r"^from \. import .*$", "", src, flags=re.M)
    mod = types.ModuleType("mk_" + name[:-3])
    mod.__dict__.update(inject)
    sys.modules[mod.__name__] = mod
    exec(compile(src, name, "exec"), mod.__dict__)
    return mod


class NotLoggedIn(Exception):
    pass


VAULT = load("vault.py")
NP = load("notes_prompts.py")
LINKER = load("linker.py", config=SimpleNamespace(), llm=SimpleNamespace(NotLoggedIn=NotLoggedIn), NP=NP, pipeline=SimpleNamespace(), vault=VAULT)
ASSIGN = load("topic_assign.py", config=SimpleNamespace(), courses=SimpleNamespace(), llm=SimpleNamespace(), pipeline=SimpleNamespace(), store=SimpleNamespace())
_FIG_DIR = Path(tempfile.mkdtemp(prefix="mk-figs-"))


class _Img:
    def save(self, path, *_a, **_k):
        Path(path).write_bytes(b"png")


NOTES = load(
    "notes.py", config=SimpleNamespace(), llm=SimpleNamespace(NotLoggedIn=NotLoggedIn), NP=NP,
    pdfio=SimpleNamespace(render_clip=lambda *a, **k: _Img()), pipeline=SimpleNamespace(), store=SimpleNamespace(job_dir=lambda _id: _FIG_DIR),
    SUB=SimpleNamespace(), vault=VAULT,
)
TOPIC = load(
    "topic_notes.py", config=SimpleNamespace(), courses=SimpleNamespace(), llm=SimpleNamespace(NotLoggedIn=NotLoggedIn), notes=NOTES, NP=NP,
    pipeline=SimpleNamespace(), store=SimpleNamespace(), topic_assign=ASSIGN, vault=VAULT,
)


def tree(root: Path) -> dict:
    """Every file of the vault: its text (or the hex of binary content)."""
    out = {}
    for p in sorted(root.rglob("*")):
        if p.is_file():
            data = p.read_bytes()
            try:
                out[p.relative_to(root).as_posix()] = data.decode("utf-8")
            except UnicodeDecodeError:
                out[p.relative_to(root).as_posix()] = "hex:" + data.hex()
    return out


def rel_result(res: dict, root: Path) -> dict:
    """A save result with the temporary vault path cut off."""
    def cut(v):
        if isinstance(v, str) and v.startswith(str(root)):
            return Path(v).relative_to(root).as_posix()
        if isinstance(v, list):
            return [cut(x) for x in v]
        if isinstance(v, dict):
            return {k: cut(x) for k, x in v.items()}
        return v
    return cut(res)


# ---------------------------------------------------------------- text rules

SAFE_NAME_CASES = [
    ("Heart: failure/valves", "Notiz", 80), ("  .Hidden. ", "Notiz", 80), ("a" * 100, "Notiz", 80), ("Ränder & Größe ‹x›", "Notiz", 80),
    ("", "Thema", 80), (None, "Fach", 80), ("[[x]] #tag ^1", "Notiz", 80), ("tab\there\nnew\x01line", "Notiz", 80), ("...", "Dokument", 80),
    ("Gelenke  der   Brustwand — Aufbau", "Notiz", 12), ("ä" * 90 + " .", "Notiz", 80),
]
SLUG_CASES = [
    ("Ribs and sternum", 40), ("Größe & Äpfel", 40), ("", 40), ("Ünïcode ß", 40), ("x" * 50, 30), ("Heart failure — Klinik", 60), ("--", 40), ("Öl", 2),
]

LEGACY = (
    "---\nfach: Anatomy\nmedanki_id: a-b\n---\n\n# Titel\n\n%% medanki:start %%\nAutomatischer Text\n%% medanki:end %%\n\n"
    "%% medanki:links:start %%\n## Verwandte Themen\n- [[x|Y]]\n%% medanki:links:end %%\n\nRest\n"
)
LEGACY_NO_BOUNDARY = "# Übersicht\n\n%% medanki:start %%\nListe\n%% medanki:end %%\n"
NOTE_TEXTS = [
    "---\nfach: \"Anatomy\"\nmedanki_id: a-b\n---\n\n# Titel\n\nAlter Text\n\n## Verwandte Themen\n- [[x|Y]] (Anatomy) – Grund\n\n## Eigene Notizen\n\nMeine Gedanken\n",
    "---\nmedanki_id: a-b\n---\n# Ohne Grenze\n\nText ohne Grenzüberschrift\n",
    "# Kein Frontmatter\n\nText\n\n## Eigene Notizen\n\nMein Text\n",
    "kein h1 hier\n\n## Eigene Notizen\n",
    "---\nmedanki_id: a-b\n---\n\n# Titel\n\n## Eigene Notizen   \n\nA\n\n## Verwandte Themen\n- [[p|q]]\n\nText danach\n",
    LEGACY, LEGACY_NO_BOUNDARY,
    "# T\n\nIntro\n\n## Verwandte Themen\n- [[a|A]]\n- [[b|B]]\n\nKein Listenpunkt mehr\n- [[c|C]]\n\n## Eigene Notizen\n",
]
BODIES = [
    "Neuer Text\n\n- Punkt", "  Mit Rand  \n", "Text\n## Eigene Notizen\nNoch Text\n## Verwandte Themen   \nEnde", "",
    "[[Ribs.pdf#page=5|Rippen · S. 5]]\n\n## Eigenes\n",
]
LINK_BLOCKS = ["## Verwandte Themen\n- [[a/b|B]] (Fach) – gleicher Grund\n- [[c|C]]", "  ## Verwandte Themen\n- [[x|X]]  "]
FRONT_CASES = [
    {"subject": "Anatomy", "id": "anat-ribs", "created": "2026-11-05", "tags": ["medizinstudium", "anatomy", "ribs"], "sources": ["Rippen.pdf", "Gelenke.pdf"], "topic": "Ribs and sternum", "moc": False},
    {"subject": "Hörsaal \"A\"", "id": "x-moc", "created": "2026-01-02", "tags": ["a"], "sources": [], "topic": None, "moc": True},
]
URL_PATHS = ["/Users/x/Documents/Medizinstudium/Anatomy/Themen/Ribs.md", "/tmp/Fach mit Leerzeichen/Ä.md"]

text_rules = {
    "safeName": [{"text": t, "fallback": f, "max": m, "out": VAULT.safe_name(t, f, m)} for t, f, m in SAFE_NAME_CASES],
    "slug": [{"text": t, "max": m, "out": VAULT.slug(t, m)} for t, m in SLUG_CASES],
    "stripLegacy": [{"text": t, "out": VAULT.strip_legacy_markers(t)} for t in NOTE_TEXTS],
    "setBody": [{"text": t, "body": b, "out": VAULT.set_body(t, b)} for t in NOTE_TEXTS for b in BODIES],
    "removeLinks": [{"text": t, "out": VAULT.remove_links_block(t)} for t in NOTE_TEXTS],
    "setLinks": [{"text": t, "block": b, "out": VAULT.set_links_block(t, b)} for t in NOTE_TEXTS for b in LINK_BLOCKS],
    "frontmatterId": [{"text": t, "out": VAULT._frontmatter_id(t)} for t in NOTE_TEXTS],
    "topicFrontmatter": [
        {"args": c, "out": VAULT._topic_frontmatter(subject=c["subject"], id=c["id"], created=c["created"], tags=c["tags"], sources=c["sources"], topic=c["topic"], moc=c["moc"])}
        for c in FRONT_CASES
    ],
    "obsidianUrl": [{"path": p, "out": VAULT.obsidian_url(Path(p))} for p in URL_PATHS],
    "graphColors": [
        {"existing": e, "subjects": s, "out": None}
        for e, s in [(None, ["Physiology", "Anatomy", "Biophysics"]), ({"colorGroups": []}, ["A"]), ({"colorGroups": [{"query": "x"}]}, ["A"]), ({"search": "q"}, [])]
    ],
}
for case in text_rules["graphColors"]:  # run MedAnki's write_graph_colors in a temp vault
    d = Path(tempfile.mkdtemp(prefix="mk-graph-"))
    if case["existing"] is not None:
        (d / ".obsidian").mkdir()
        (d / ".obsidian" / "graph.json").write_text(json.dumps(case["existing"]), encoding="utf-8")
    wrote = VAULT.write_graph_colors(d, case["subjects"])
    g = d / ".obsidian" / "graph.json"
    case["out"] = {"wrote": wrote, "file": g.read_text(encoding="utf-8") if g.exists() else None}

# ---------------------------------------------------------------- topic-note helpers

REFS = {
    "D1": {"ref": "D1", "job_id": "j1", "name": "5. Ribs and sternum", "pdf_file": "5. Ribs and sternum.pdf"},
    "D2": {"ref": "D2", "job_id": "j2", "name": "Joints of the thorax", "pdf_file": "Joints of the thorax.pdf"},
}
FIG_CANDS = [
    {"id": "D1_p005_F1", "page": 5, "ref": "D1", "src": "figs/D1_p005_F1.png", "caption": "Abb. 3: A typical rib", "area": 0.2},
    {"id": "D2_p004_F2", "page": 4, "ref": "D2", "src": "figs/D2_p004_F2.png", "caption": "", "area": 0.1},
]
TOPIC_MD = [
    "# Ignored title\n\n> [!abstract] Kernaussagen\n> - Ribs I–VII are true ribs (D1 S. 5)\n\n## Anatomy\n- **Costa** has a head (D1 S. 5-6, D2 S. 4)\n- Unknown (D9 S. 1)\n\n"
    "{{FIG D1_p005_F1 | A typical rib.}}\n- after figure\n{{FIG D2_p004_F2}}\n{{FIG D1_p005_F1 | twice}}\n{{FIG nope | x}}\n",
    "No heading.\r\nLine two (D2 S. 4–5)\r\n\r\n\r\n\r\nText",
]
LAYOUT = {
    "lines": [
        {"text": "Ribs", "bbox": [0.1, 0.05, 0.3, 0.1], "bold": True, "italic": False, "underline": False},
        {"text": "Abb. 3: A typical rib", "bbox": [0.1, 0.55, 0.4, 0.6], "bold": False, "italic": False, "underline": False},
        {"text": "  ", "bbox": [0, 0, 0, 0]},
        {"text": "Legend text", "src": "legend", "bbox": [0, 0, 0, 0]},
        {"text": "see figure", "bbox": [0.5, 0.3, 0.9, 0.35], "bold": False, "italic": True, "underline": False},
        {"text": "far caption", "bbox": [0.1, 0.9, 0.4, 0.95], "bold": False, "italic": False, "underline": False},
        {"text": "Figure 12 elsewhere", "bbox": [0.7, 0.9, 0.95, 0.95], "bold": False, "italic": False, "underline": True},
    ],
    "figures": [
        {"id": "F1", "bbox": [0.1, 0.1, 0.4, 0.5]},
        {"id": "F2", "bbox": [0.5, 0.1, 0.52, 0.12]},
        {"id": "F3", "bbox": [0.0, 0.0, 1.0, 1.0]},
        {"id": "F4", "bbox": [0.6, 0.4, 0.95, 0.88]},
    ],
}
MARKDOWN_COUNT = [
    "---\nfach: x\n---\nHello **world** and more\n![[a.png|560]]\n{{FIG x | y}}\nSee (S. 12) and (p. 4-5, 7) here\n[[a.pdf#page=3|Source · S. 3]] tail [[Note|shown]] end",
    "", "Zahlen 3,5 und ’s foo-bar l'été",
]
TRIM_TEXT = "line one two\nthree four five six\nseven\neight nine"

topic_helpers = {
    "countWords": [{"text": t, "out": NOTES.count_words(t)} for t in MARKDOWN_COUNT],
    "pageText": NOTES.page_text(LAYOUT),
    "captionFor": [{"bbox": f["bbox"], "out": NOTES._caption_for(f["bbox"], LAYOUT["lines"])} for f in LAYOUT["figures"]],
    "layout": LAYOUT,
    "trimWords": [{"text": TRIM_TEXT, "limit": n, "out": TOPIC._trim_words(TRIM_TEXT, n)} for n in (1, 3, 5, 6, 100)],
    "short": [{"name": n, "out": TOPIC._short(n)} for n in ("5. Ribs and sternum", "12_Joints", "Plain", "7 - " + "x" * 60, "5.", "")],
    "toObsidianTopic": [
        {"markdown": m, "topic": t, "maxFigs": k, "refs": REFS, "cands": FIG_CANDS,
         "out": (lambda r: {"markdown": r[0], "used": r[1]})(TOPIC.to_obsidian_topic(m, topic=t, refs=REFS, cands=FIG_CANDS, max_figs=k))}
        for m in TOPIC_MD for t, k in (("Ribs and sternum", 4), ("Größe: Gelenke", 1))
    ],
    "linkRefs": [{"md": m, "out": TOPIC.link_refs(m, REFS)} for m in ("(D1 S. 5) and (D2 S. 4-5, D1 S. 7–8) and D3 S. 1", "no refs here", "D1 S. 12")],
    "tidy": [{"md": m, "out": TOPIC.tidy(m)} for m in ("line\n![[a.png|560]]\nnext\n\n\n\n![[b.png]]", "a\n\n\n\nb", "  text  ")],
    "stub": [{"args": a, "out": TOPIC._stub(*a)} for a in ((1, "Ribs", 5), (2, "Valves", 0, 3), (3, "Empty", 0, 0))],
    "figureCandidates": None,  # filled below
}
_fc_pages = [{"page": 5, "layout": {**LAYOUT}}, {"page": 7, "layout": {"lines": LAYOUT["lines"], "figures": [{"id": "F1", "bbox": [0.1, 0.1, 0.3, 0.3]}, {"id": "F2", "bbox": [0.1, 0.5, 0.6, 0.9]}]}}]
topic_helpers["figureCandidatesInput"] = _fc_pages
topic_helpers["figureCandidates"] = [{"limit": n, "out": [{k: v for k, v in c.items() if k != "src"} for c in NOTES.figure_candidates("jobx", _fc_pages, limit=n)]} for n in (4, 1, 8)]
topic_helpers["noteBudget"] = []

CARD_TEXTS = [
    {"type": "basic", "front": "What is the\nmost common cause?", "back": "CAD"},
    {"type": "cloze", "text": "The {{c1::aortic valve::valve}} has {{c2::three}} cusps."},
    {"type": "image_occlusion", "header": "Heart", "label": "Left atrium"},
]
topic_prompts = {
    "topicSystem": NP.topic_system("en"),
    "topicPrompt": {
        "course": "Anatomy", "topic": "Ribs and sternum", "cards": ["Q – A", "Cloze"], "material": "=== D1 · S. 5 ===\ntext", "cands": FIG_CANDS, "words": 600, "figs": 2,
        "out": NP.topic_prompt("Anatomy", "Ribs and sternum", ["Q – A", "Cloze"], "=== D1 · S. 5 ===\ntext", FIG_CANDS, 600, 2),
        "noCands": NP.topic_prompt("Anatomy", "Ribs", [], "m", [], 350, 0),
    },
    "trimSystem": NP.TRIM_SYSTEM,
    "trimPrompt": {"words": 400, "markdown": "## A\n- b {{FIG x | y}}", "out": NP.trim_prompt(400, "## A\n- b {{FIG x | y}}")},
    "linkSystem": NP.LINK_SYSTEM,
    "headingSystem": TOPIC._HEADING_SYSTEM,
    "headingBatch": TOPIC.HEADING_BATCH,
    "headingPrompt": {
        "topics": ["Heart failure", "Valves"], "batch": [["j1", 3, "Heart failure basics"], ["j2", 7, "Aortic stenosis"]],
        "out": TOPIC._heading_prompt(["Heart failure", "Valves"], [("j1", 3, "Heart failure basics"), ("j2", 7, "Aortic stenosis")]),
    },
}
LINK_SOURCES = [
    {"id": "n1", "title": "Ribs", "subject": "Anatomy", "doc": "", "abstract": "Ribs I–VII are true.", "terms": ["Costa", "Sternum"],
     "cands": [{"id": "n2", "title": "Thoracic joints", "subject": "Anatomy", "doc": "", "terms": ["Articulatio"], "score": 0.4321}, {"id": "n3", "title": "Breathing", "subject": "", "doc": "", "terms": [], "score": 0.1}]},
    {"id": "n2", "title": "Joints", "subject": "", "doc": "Skript", "abstract": "", "terms": [], "cands": []},
]
topic_prompts["linkPrompt"] = {"sources": LINK_SOURCES, "out": NP.link_prompt(LINK_SOURCES)}
topic_prompts["cardText"] = [{"card": c, "out": ASSIGN._card_text(c)} for c in CARD_TEXTS]

# ---------------------------------------------------------------- scenarios on a vault


def topics_input(subject: str, course_id: str, rows: list, created: str = "2026-11-05") -> dict:
    return {"subject": subject, "courseId": course_id, "created": created, "topics": rows}


RIBS_MD = (
    "> [!abstract] Kernaussagen\n> - Ribs I–VII are **true ribs** with direct sternal attachment\n> - The costal groove carries the intercostal nerve\n\n"
    "## Anatomy of a rib\n- **Costa** has a head, neck and body ([[Rippen.pdf#page=5|Rippen · S. 5]])\n- Costal angle marks the greatest curvature\n\n"
    "![[Ribs-and-sternum_D1_p005_F1.png|560]]\n*Abb.: A typical rib* [[Rippen.pdf#page=5|Rippen · S. 5]]\n\n## Sternum\n- **Manubrium**, corpus and xiphoid process\n"
)
JOINTS_MD = (
    "> [!abstract] Kernaussagen\n> - Costovertebral and sternocostal joints enable breathing\n\n## Joints\n- **Articulatio costovertebralis** connects rib head and vertebra "
    "([[Gelenke.pdf#page=4|Gelenke · S. 4]])\n- Respiration uses **rib movements** (bucket handle, pump handle)\n\n## Eigene Notizen\nthis would break the boundary\n"
)
HEART_MD = "> [!abstract] Kernaussagen\n> - **Heart failure** reduces cardiac output\n\n## Clinic\n- **Troponin** rises in myocardial infarction\n- Symptoms: dyspnoea, oedema\n"
VALVES_MD = "> [!abstract] Kernaussagen\n> - **Aortic stenosis** narrows the outflow tract\n\n## Valves\n- **Heart failure** can follow severe stenosis\n- **Mitral valve** regurgitation\n"
BREATH_MD = "> [!abstract] Kernaussagen\n> - **Respiration** moves air by **rib movements** and the diaphragm\n\n## Mechanics\n- Costal breathing lifts the **sternum**\n- Diaphragm contracts\n"

ANATOMY_ROWS = [
    {"mid": "anatomy-ribs-and-sternum", "title": "Ribs and sternum", "markdown": RIBS_MD, "cards": 12, "tags": ["medizinstudium", "anatomy", "ribs"]},
    {"mid": "anatomy-joints", "title": "Joints: costovertebral / sternocostal", "markdown": JOINTS_MD, "cards": 7, "tags": ["medizinstudium", "anatomy"]},
    {"mid": "anatomy-heart-failure", "title": "Heart failure #1", "markdown": HEART_MD, "cards": 3, "tags": ["medizinstudium", "anatomy", "heart"]},
]
PHYSIO_ROWS = [
    {"mid": "physio-valves", "title": "Valves", "markdown": VALVES_MD, "cards": 5, "tags": ["medizinstudium", "physiology"]},
    {"mid": "physio-breathing", "title": "Breathing mechanics", "markdown": BREATH_MD, "cards": 6, "tags": ["medizinstudium", "physiology", "respiration"]},
]
FILES = {
    "pdfs": [["Rippen.pdf", "%PDF-1.4 ribs v1"], ["Gelenke.pdf", "%PDF-1.4 joints"]],
    "figs": [["Ribs-and-sternum_D1_p005_F1.png", "PNG-fake-1"]],
    "sources": ["Rippen.pdf", "Gelenke.pdf"],
}
FOREIGN_NOTE = "# Heart failure\n\nMy own note about heart failure, troponin and valves.\n\n**Troponin** is the marker.\n"
FOREIGN_TOPIC = "# New topic\n\nSomething I wrote myself.\n"


def run_scenario() -> dict:
    root = Path(tempfile.mkdtemp(prefix="mk-vault-"))
    srcs = Path(tempfile.mkdtemp(prefix="mk-src-"))
    steps = []

    def save(subject, course_id, rows, files, created="2026-11-05"):
        pdfs, figs = [], []
        for name, content in files["pdfs"]:
            p = srcs / ("pdf-" + hashlib.md5((name + content).encode()).hexdigest()[:6])
            p.write_text(content, encoding="utf-8")
            pdfs.append((p, name))
        for name, content in files["figs"]:
            p = srcs / ("fig-" + hashlib.md5((name + content).encode()).hexdigest()[:6])
            p.write_text(content, encoding="utf-8")
            figs.append((p, name))
        res = VAULT.save_topic_notes(root, subject=subject, course_id=course_id, topics=rows, pdfs=pdfs, figs=figs, pdf_sources=files["sources"], created=created)
        steps.append({"op": "save", "args": {**topics_input(subject, course_id, rows, created), "files": files}, "result": rel_result(res, root), "tree": tree(root)})

    def edit(rel, text):
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        steps.append({"op": "edit", "path": rel, "text": text, "tree": tree(root)})

    def link():
        res = LINKER.run(root, use_llm=False)
        res = {k: v for k, v in res.items() if k != "at"}
        steps.append({"op": "link", "result": res, "tree": tree(root)})

    def unlink():
        steps.append({"op": "unlink", "result": LINKER.unlink(root), "tree": tree(root)})

    save("Anatomy", "anatomy", ANATOMY_ROWS, FILES)
    save("Physiology", "physio", PHYSIO_ROWS, {"pdfs": [["Physio.pdf", "%PDF-1.4 physio"]], "figs": [], "sources": ["Physio.pdf"]})
    edit("Anatomy/Themen/Ribs and sternum.md", (root / "Anatomy/Themen/Ribs and sternum.md").read_text(encoding="utf-8") + "My own thought about the manubrium.\n")
    edit("Allgemein/Heart failure.md", FOREIGN_NOTE)
    edit("Anatomy/Themen/Joints costovertebral sternocostal.md", (root / "Anatomy/Themen/Joints costovertebral sternocostal.md").read_text(encoding="utf-8").replace("## Eigene Notizen", "## Mein Bereich"))
    link()
    edit("Anatomy/Themen/New topic.md", FOREIGN_TOPIC)
    more = ANATOMY_ROWS + [{"mid": "anatomy-new-topic", "title": "New topic", "markdown": "> [!abstract] Kernaussagen\n> - **New** things\n\n## A\n- text\n", "cards": 1, "tags": ["medizinstudium", "anatomy"]}]
    save("Anatomy", "anatomy", more, {"pdfs": [["Rippen.pdf", "%PDF-1.4 ribs v2 changed"], ["Gelenke.pdf", "%PDF-1.4 joints"]], "figs": FILES["figs"], "sources": FILES["sources"]}, "2026-11-06")
    link()
    unlink()
    return {"steps": steps}


def legacy_scenario() -> dict:
    root = Path(tempfile.mkdtemp(prefix="mk-legacy-"))
    (root / "Anatomy/Doc").mkdir(parents=True)
    files = {
        "Anatomy/Doc/01 Ribs.md": "---\nfach: Anatomy\nmedanki_id: old-1\ntags:\n  - medizinstudium\n  - anatomy\n---\n\n# Ribs\n\n%% medanki:start %%\nText about **rib** and **sternum** cartilage.\n%% medanki:end %%\n\n## Eigene Notizen\n\nmine\n",
        "Anatomy/Doc/02 Sternum.md": "---\nfach: Anatomy\nmedanki_id: old-2\ntags:\n  - medizinstudium\n  - anatomy\n---\n\n# Sternum\n\nText about **sternum** and **rib** cartilage.\n\n## Eigene Notizen\n\n",
        "Anatomy/Doc/Doc.md": "---\nmedanki_id: old-moc\nmedanki_moc: true\n---\n\n# Doc\n\nList\n\n## Eigene Notizen\n",
        "Übersicht.md": "# Übersicht\n\n%% medanki:start %%\nalt\n%% medanki:end %%\n",
        "Private/Mine.md": "# Mine\n\nMy **sternum** and **rib** cartilage notes.\n",
    }
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding="utf-8")
    before = tree(root)
    res = LINKER.run(root, use_llm=False)
    return {"before": before, "result": {k: v for k, v in res.items() if k != "at"}, "after": tree(root), "migrated": None}


# ---------------------------------------------------------------- the linker's own pieces

def linker_cases() -> dict:
    root = Path(tempfile.mkdtemp(prefix="mk-link-"))
    for rel, text in {
        "Anatomy/Themen/01 Ribs.md": "---\nfach: \"Anatomy\"\nthema: \"Ribs\"\ntags:\n  - medizinstudium\n  - anatomy\n  - ribs\nmedanki_id: a-1\n---\n\n# Ribs\n\n> [!abstract] Kernaussagen\n> - **Costa** is the rib\n> - Ribs protect the thorax\n\n## Rib anatomy\n- **Costa** head, neck, body\n- Costal groove\n\n## Eigene Notizen\n",
        "Anatomy/Themen/02 Sternum.md": "---\nfach: \"Anatomy\"\ntags:\n  - medizinstudium\n  - anatomy\n  - sternum\nmedanki_id: a-2\n---\n\n# Sternum\n\n> [!abstract] Kernaussagen\n> - **Costa** attachment at the sternum\n\n## Sternum anatomy\n- **Manubrium**, body, xiphoid\n- Costal notches\n\n## Verwandte Themen\n- [[Anatomy/Themen/01 Ribs|Ribs]]\n\n## Eigene Notizen\n",
        "Anatomy/Themen/03 Heart.md": "---\nfach: \"Anatomy\"\ntags: [anatomy, heart]\nmedanki_id: a-3\n---\n\n# Heart\n\n## Cardiac chambers\n- **Atrium**, **ventricle**\n- Valves regulate flow\n\n## Eigene Notizen\n",
        "Physiology/Themen/Valves.md": "---\nfach: \"Physiology\"\nmedanki_id: p-1\n---\n\n# Valves\n\n> [!abstract] Kernaussagen\n> - **Valves** regulate **cardiac** flow\n\n## Cardiac valves\n- **Atrium** pressure and **ventricle** filling\n\n## Eigene Notizen\n",
        "Physiology/Themen/00 Übersicht.md": "---\nfach: \"Physiology\"\nmedanki_id: p-moc\nmedanki_moc: true\n---\n\n# Physiology – Themen\n\n## Themen\n- [[x]]\n\n## Eigene Notizen\n",
        "Notes/Private.md": "# Private\n\nMy **valves** and **atrium** cardiac notes.\n",
    }.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding="utf-8")
    notes = LINKER.scan(root)
    cands = LINKER.similarities(notes)
    picked = {"n1": {"n2": "same thorax", "n9": "ghost"}, "n4": {"n3": ""}, "n5": {"n1": "foreign source"}}
    by_id = {n.id: n for n in notes}
    # only picks that exist as candidates: mimic what _refine allows
    picked = {s: {t: w for t, w in ts.items() if any(c["id"] == t for c in cands.get(s, []))} for s, ts in picked.items()}
    links = LINKER.build_links(notes, cands, picked)
    return {
        "files": {p.relative_to(root).as_posix(): p.read_text(encoding="utf-8") for p in sorted(root.rglob("*.md"))},
        "notes": [{"id": n.id, "rel": n.rel, "title": n.title, "subject": n.subject, "doc": n.doc, "ix": n.ix, "owned": n.owned, "abstract": n.abstract, "terms": n.terms, "weights": dict(n.weights)} for n in notes],
        "candidates": {k: [{"id": c["id"], "score": c["score"], "shared": c["shared"]} for c in v] for k, v in cands.items()},
        "picked": picked,
        "links": links,
        "blocks": {nid: LINKER._block_body(by_id[nid], rows, by_id) for nid, rows in links.items()},
        "reason": LINKER._reason(["a", "b", "c", "d"]),
    }


fixture = {
    "textRules": text_rules,
    "topicHelpers": topic_helpers,
    "prompts": topic_prompts,
    "constants": {
        "linker": {k: getattr(LINKER, k) for k in ("MAX_LINKS", "CANDIDATES", "PICK", "BATCH", "MIN_SIM", "MIN_SIM_NO_LLM", "MIN_SHARED", "SAME_DOC_FACTOR", "COMMON_DF")},
        "stop": sorted(LINKER._STOP),
        "topic": {k: getattr(TOPIC, k) for k in ("MAX_PAGES", "PAGE_WORDS", "CARDS_MAX", "TOPIC_FIGS", "FIG_CANDIDATES", "WORDS_MIN", "WORDS_MAX", "WORKERS")},
        "notes": {k: getattr(NOTES, k) for k in ("TRIM_FACTOR", "MAX_CANDIDATES")},
        "vault": {k: getattr(VAULT, k) for k in ("OWN_HEADING", "LINKS_HEADING", "INDEX_NAME", "SAVE_DIR", "MOC_NAME", "ASSETS")},
    },
    "scenario": run_scenario(),
    "legacy": legacy_scenario(),
    "linker": linker_cases(),
}
OUT.write_text(json.dumps(fixture, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
