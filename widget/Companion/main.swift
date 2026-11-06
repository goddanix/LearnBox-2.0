import AppKit
import ServiceManagement
import WidgetKit
import os

// Learnbox 2.0 Widget — the companion app that keeps the widget's numbers fresh.
//
// The widget itself cannot run anything. This small background app does, at the moments the numbers can have
// changed — at login, when the screen unlocks, when the Mac wakes, when Learnbox 2.0 quits, and every 15 minutes —
// and then asks WidgetKit to redraw:
//   1. run the helper program (widget-helper.mjs, inside this app) with the desktop app's own Electron binary as
//      Node (ELECTRON_RUN_AS_NODE=1); it reads the study ledgers and writes widget.json;
//   2. if the numbers changed (or on the first run), WidgetCenter.reloadAllTimelines().
// Tapping the widget (learnbox-widget://open) opens Learnbox 2.0.
//
//   "Learnbox 2.0 Widget" --refresh-once   run the helper once, print its answer, exit (install script, tests)
// For tests: LEARNBOX_WIDGET_DATA_DIR / LEARNBOX_WIDGET_OUT point the helper at scratch folders.

let learnboxBundleID = "com.learnbox.Learnbox"
let log = Logger(subsystem: "com.learnbox.LearnboxWidget", category: "companion")

/// The result of one helper run.
enum Refresh {
    case updated(changed: Bool)
    case failed(String)
}

func learnboxApp() -> URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: learnboxBundleID) }

/// Runs the helper once and waits for it. Safe to call off the main thread.
func runHelper() -> Refresh {
    guard let app = learnboxApp(), let node = Bundle(url: app)?.executableURL else {
        return .failed("Learnbox 2.0 is not installed (no app with id \(learnboxBundleID))")
    }
    guard let helper = Bundle.main.url(forResource: "widget-helper", withExtension: "mjs") else {
        return .failed("widget-helper.mjs is missing from the widget app")
    }
    var arguments = [helper.path]
    let env = ProcessInfo.processInfo.environment
    if let dir = env["LEARNBOX_WIDGET_DATA_DIR"] { arguments += ["--data-dir", dir] }
    if let out = env["LEARNBOX_WIDGET_OUT"] { arguments += ["--out", out] }

    let process = Process()
    process.executableURL = node
    process.arguments = arguments
    var environment = env
    environment["ELECTRON_RUN_AS_NODE"] = "1"
    process.environment = environment
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    do { try process.run() } catch { return .failed("could not start the helper: \(error)") }

    // Drain both pipes while it runs, give it 60 s, then stop it.
    let group = DispatchGroup()
    var out = Data(), err = Data()
    group.enter()
    DispatchQueue.global().async { out = stdout.fileHandleForReading.readDataToEndOfFile(); group.leave() }
    group.enter()
    DispatchQueue.global().async { err = stderr.fileHandleForReading.readDataToEndOfFile(); group.leave() }
    let killer = DispatchWorkItem { if process.isRunning { process.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + 60, execute: killer)
    process.waitUntilExit()
    killer.cancel()
    group.wait()

    let line = String(decoding: out, as: UTF8.self).split(separator: "\n").last.map(String.init) ?? ""
    guard process.terminationStatus == 0,
          let json = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
          json["ok"] as? Bool == true
    else {
        let detail = String(decoding: err, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return .failed("helper exited with \(process.terminationStatus): \(detail.isEmpty ? line : detail)")
    }
    return .updated(changed: json["changed"] as? Bool ?? true)
}

func openLearnbox() {
    guard let url = learnboxApp() else { return }
    NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
}

final class Companion: NSObject, NSApplicationDelegate {
    private let queue = DispatchQueue(label: "com.learnbox.LearnboxWidget.refresh")
    private var scheduled = false
    private var first = true
    private var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        registerLoginItemOnce()
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(self, selector: #selector(applicationTerminated(_:)), name: NSWorkspace.didTerminateApplicationNotification, object: nil)
        workspace.addObserver(self, selector: #selector(refreshSoon), name: NSWorkspace.didWakeNotification, object: nil)
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(refreshSoon), name: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil)
        let timer = Timer.scheduledTimer(withTimeInterval: 15 * 60, repeats: true) { [weak self] _ in self?.refreshSoon() }
        timer.tolerance = 60
        self.timer = timer
        refreshSoon()
    }

    /// Only the first launch: asks macOS to start this app at login (visible, and switchable off, in System
    /// Settings → General → Login Items). A later "off" there is respected — it is not registered again.
    private func registerLoginItemOnce() {
        let key = "didRegisterLoginItem"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        do { try SMAppService.mainApp.register() } catch { log.error("login item: \(error.localizedDescription, privacy: .public)") }
    }

    @objc private func applicationTerminated(_ note: Notification) {
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
              app.bundleIdentifier == learnboxBundleID else { return }
        refreshSoon()
    }

    /// Several triggers at once (unlock + wake) make one run, two seconds later.
    @objc func refreshSoon() {
        queue.async {
            guard !self.scheduled else { return }
            self.scheduled = true
            self.queue.asyncAfter(deadline: .now() + 2) {
                self.scheduled = false
                self.refreshNow()
            }
        }
    }

    private func refreshNow() {
        switch runHelper() {
        case .updated(let changed):
            if changed || first {
                first = false
                DispatchQueue.main.async { WidgetCenter.shared.reloadAllTimelines() }
            }
            log.info("helper ok, changed=\(changed, privacy: .public)")
        case .failed(let message):
            log.error("helper failed: \(message, privacy: .public)")
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) { openLearnbox() }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openLearnbox()
        return false
    }
}

if CommandLine.arguments.contains("--refresh-once") {
    switch runHelper() {
    case .updated(let changed):
        print("{\"ok\":true,\"changed\":\(changed)}")
        exit(0)
    case .failed(let message):
        FileHandle.standardError.write(Data("\(message)\n".utf8))
        exit(1)
    }
}

let application = NSApplication.shared
let delegate = Companion()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
