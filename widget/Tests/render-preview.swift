import AppKit
import SwiftUI
import WidgetKit

// Draws the widget's views to PNG files, to look at the layout without placing a widget:
//   render-preview <widget.json | "sample"> <out-dir>
// Writes small.png, medium.png and large.png (2x). Built with -DWIDGET_PREVIEW_TOOL together with
// widget/Shared/Snapshot.swift and widget/Widget/LearnboxWidget.swift (see widget/README.md).
// WidgetKit draws the real background; here a plain one stands in for it.

@MainActor
func render(_ state: LoadState, family: WidgetFamily, size: CGSize, to url: URL, dark: Bool) {
    let view = LearnboxWidgetView(entry: LearnboxEntry(date: Date(), state: state), familyOverride: family)
        .padding(16)
        .frame(width: size.width, height: size.height)
        .background(dark ? Color(white: 0.17) : Color(white: 0.93))
        .environment(\.colorScheme, dark ? .dark : .light)
    let renderer = ImageRenderer(content: view)
    renderer.scale = 2
    guard let image = renderer.nsImage, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: NSBitmapImageRep.FileType.png, properties: [:]) else {
        FileHandle.standardError.write(Data("could not render \(url.lastPathComponent)\n".utf8))
        return
    }
    try? png.write(to: url)
}

@MainActor
func main() {
    guard CommandLine.arguments.count > 2 else {
        FileHandle.standardError.write(Data("usage: render-preview <widget.json|sample|missing> <out-dir>\n".utf8))
        exit(2)
    }
    let source = CommandLine.arguments[1]
    let out = URL(fileURLWithPath: CommandLine.arguments[2])
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    let state: LoadState
    switch source {
    case "sample": state = .snapshot(.sample)
    case "missing": state = .missing
    default:
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: source)), let snap = try? WidgetSnapshot.decode(data) else {
            FileHandle.standardError.write(Data("cannot read \(source)\n".utf8))
            exit(1)
        }
        state = .snapshot(snap)
    }
    // the sizes macOS gives the widget families (points)
    let families: [(String, WidgetFamily, CGSize)] = [
        ("small", .systemSmall, CGSize(width: 170, height: 170)),
        ("medium", .systemMedium, CGSize(width: 364, height: 170)),
        ("large", .systemLarge, CGSize(width: 364, height: 382)),
    ]
    for (name, family, size) in families {
        render(state, family: family, size: size, to: out.appendingPathComponent("\(name).png"), dark: false)
        render(state, family: family, size: size, to: out.appendingPathComponent("\(name)-dark.png"), dark: true)
    }
}

MainActor.assumeIsolated { main() }
