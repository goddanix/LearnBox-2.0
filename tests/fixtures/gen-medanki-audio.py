"""Regenerates tests/fixtures/medanki-audio.json from MedAnki's own audio code.

Run:  PYTHONDONTWRITEBYTECODE=1 python3 tests/fixtures/gen-medanki-audio.py [path/to/MedAnki/medanki]

MedAnki's modules are executed from their source text only (nothing is imported from, or written into, the MedAnki
folder): audio_prompts.py (the script prompt) and audio.py (`script_budget`). tests/audio-script.test.ts and
tests/audio-prompts.test.ts compare the TypeScript versions with this output. The material of a script is built inline
in audio.py's `_run_script` (not a function), so its two lines are repeated here with the same expressions.
"""
import json
import re
import sys
import types
from pathlib import Path
from types import SimpleNamespace

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / "Desktop/CLAUDE/MedAnki/medanki")
OUT = Path(__file__).with_name("medanki-audio.json")


def load(name: str, **inject):
    """A MedAnki module from its source text, its `from . import …` lines replaced by what the caller injects."""
    src = (SRC / name).read_text(encoding="utf-8").replace("from __future__ import annotations\n", "")
    src = re.sub(r"^from \. import .*$", "", src, flags=re.M)
    mod = types.ModuleType("mk_" + name[:-3])
    mod.__dict__.update(inject)
    sys.modules[mod.__name__] = mod
    exec(compile(src, name, "exec"), mod.__dict__)
    return mod


AP = load("audio_prompts.py")
AUDIO = load("audio.py", AP=AP, config=SimpleNamespace(), elevenlabs=SimpleNamespace(), llm=SimpleNamespace(NotLoggedIn=Exception),
             pipeline=SimpleNamespace(), store=SimpleNamespace(), NOTES=SimpleNamespace(NotesError=Exception))


def material(docs):
    """audio.py `_run_script`: the blocks of the documents with text, and the number of pages of all of them."""
    blocks, total_pages = [], 0
    for name, pages in docs:
        total_pages += len(pages)
        text = "\n\n".join(f"=== Seite {p['page']} ===\n{p['text']}" for p in pages if p["text"].strip())
        if text.strip():
            blocks.append(f"##### Dokument: {name} #####\n{text}")
    return {"text": "\n\n".join(blocks), "totalPages": total_pages}


DOCS = [
    [("Lecture 1", [{"page": 3, "text": "Heart\n★ Atrium"}, {"page": 4, "text": "  "}, {"page": 5, "text": "Valves"}]), ("Empty", [{"page": 1, "text": ""}])],
    [("Only", [{"page": 7, "text": "x"}])],
    [("Nothing", [{"page": 1, "text": " "}, {"page": 2, "text": ""}])],
    [],
]

out = {
    "scriptSystem": AP.SCRIPT_SYSTEM,
    "wordsPerMinute": AP.WORDS_PER_MINUTE,
    "prompts": [
        {"docName": n, "words": w, "material": m, "out": AP.script_prompt(n, w, m)}
        for n, w, m in (("Cardiology", 700, "=== Seite 1 ===\nHeart"), ("Biophysics Labs: Ultrasound", 1655, "##### Dokument: A #####\n=== Seite 2 ===\n★ x"), ("X", 90, "m"), ("Half 0.5", 75, "m"), ("Half 1.5", 225, "m"), ("Half 2.5", 375, "m"), ("Half 3.5", 525, "m"))
    ],
    "budget": [{"pages": n, "words": AUDIO.script_budget(n)} for n in (0, 1, 3, 4, 19, 20, 21, 56, 57, 100, 1000)],
    "material": [{"docs": [{"name": n, "pages": ps} for n, ps in docs], "out": material(docs)} for docs in DOCS],
}
OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("wrote", OUT, len(OUT.read_bytes()), "bytes")
