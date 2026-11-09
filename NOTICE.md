# Notice

Learnbox is a **modified version (a fork) of LearnHarness** by **Amos Blomqvist**:
<https://github.com/amosblomqvist/learnharness>

LearnHarness is free software under the **GNU Affero General Public License, version 3 only** (AGPL-3.0-only).
Learnbox keeps that license: the whole of this repository is licensed under the AGPL-3.0-only, see [LICENSE](LICENSE).
Without LearnHarness, Learnbox would not exist. Thank you to its author.

## What this is based on

| | |
|---|---|
| Original work | LearnHarness 0.3.8 by Amos Blomqvist |
| Starting point | commit `3dc8847` ("chore: prepare 0.3.8"), 26 October 2026. It is the first commit of this repository and is unchanged. |
| Modified by | GodDanix (<https://github.com/goddanix>) |
| Modified since | 4 November 2026 (first own commit). Every change is dated in the git history (`git log`). |

## That it was modified (AGPL-3.0 section 5(a))

This is **not** the original LearnHarness. Among other things, the following was added or changed:

- a study area: spaced-repetition review (FSRS), planning of new cards up to an exam date, Anki import and `.apkg` export;
- a create area: flashcards and multiple-choice questions from PDFs with an AI model, courses and topics, Obsidian notes, audio summaries;
- lessons linked to courses and flashcards, and a lecture library;
- an offline phone app (a web app on the phone that syncs with the Mac, choosing courses and subdecks);
- a provider that uses the local Claude CLI;
- a new name (Learnbox 2.0), a new icon and logo mark, and a build and update script for Intel Macs (`scripts/learnbox-update.sh`).

The git history is the complete and authoritative list of changes.

## No affiliation

Learnbox is an independent project. It is **not** made, endorsed or supported by Amos Blomqvist. The name "LearnHarness" and its logo are not covered by the AGPL and are not used as the name or logo of Learnbox. Parts of the inherited release set-up still carry LearnHarness artwork or names and are not used for Learnbox's own build: `build/icon.icon`, `.github/workflows/release.yml` and the Apple-silicon part of `electron-builder.yml`. Learnbox's own Intel build is `electron-builder.intel.yml`.

## Source code (AGPL-3.0 section 13)

The complete corresponding source of Learnbox is published at <https://github.com/goddanix/LearnBox-2.0>. If you use Learnbox over a network, for example through the phone app, you can get the source there. The app's settings link to it.

## Third-party software

Learnbox uses open-source packages under their own licenses (mostly MIT, Apache-2.0, ISC and BSD; see `package.json` and `package-lock.json`). The fonts in `public/fonts` are under the SIL Open Font License (`public/fonts/OFL.txt`). A packaged app also contains Electron and Chromium; their notices are in the app bundle (for example `LICENSES.chromium.html`).

## Copyright

- LearnHarness: copyright by its authors, Amos Blomqvist and contributors, under the AGPL-3.0-only.
- Changes and additions in Learnbox: Copyright (C) 2026 GodDanix, under the AGPL-3.0-only.

This program comes with ABSOLUTELY NO WARRANTY, as set out in the license.
