# Learnbox 2.0 — macOS widget

A real WidgetKit widget (small, medium, large) showing, per course, the cards due now, the new cards of the day and
the days to the exam — the review screen's own numbers (`src/core/widget-snapshot.ts`).

```
Learnbox 2.0 Widget.app            built by scripts/build-widget.mjs, installed by `npm run learnbox:update -- --widget`
  Contents/MacOS/LearnboxWidgetCompanion   background app (widget/Companion/main.swift)
  Contents/Resources/widget-helper.mjs     helper program (scripts/widget-helper.ts, one file)
  Contents/PlugIns/LearnboxWidget.appex    the widget (widget/Widget/, sandboxed)
```

How the numbers travel — the widget cannot run anything and may read exactly one folder:

1. The companion starts at login and again when the screen unlocks, the Mac wakes, Learnbox 2.0 quits, and every 15
   minutes.
2. It runs the helper with the desktop app's own Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`). The helper reads
   the study ledgers **read-only** and writes `~/Library/Application Support/Learnbox/widget/widget.json` atomically.
3. If the numbers changed, the companion calls `WidgetCenter.reloadAllTimelines()`; the widget re-reads the file (its
   sandbox exception, `Widget/widget.entitlements`, allows only that folder, read-only).
4. Tapping the widget opens Learnbox 2.0 (`learnbox-widget://open`, handled by the companion).

Files: `Shared/Snapshot.swift` is the file format (versioned; `tests/widget-swift.test.ts` decodes a real helper
snapshot with it). `Tests/render-preview.swift` draws the views to PNGs, to see the layout without placing a widget:

```bash
mkdir -p /tmp/lbw && cp widget/Tests/render-preview.swift /tmp/lbw/main.swift
swiftc -O -DWIDGET_PREVIEW_TOOL widget/Shared/Snapshot.swift widget/Widget/LearnboxWidget.swift /tmp/lbw/main.swift \
  -o /tmp/lbw/render-preview -framework AppKit -framework SwiftUI -framework WidgetKit
/tmp/lbw/render-preview sample /tmp/lbw/out        # or a widget.json instead of "sample"
```

Signing is ad-hoc (a local build); `LEARNBOX_WIDGET_SIGN_IDENTITY` overrides it. Remove: `npm run learnbox:update --
--widget-remove`, then take the widget off the desktop.

The older Anki widget (`~/Desktop/CLAUDE/AnkiDeckWidget`, Shortcuts + a Python LaunchAgent) is independent and stays
as it is; it shows Anki's decks, this one shows Learnbox's courses.
