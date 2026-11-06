import Foundation

// Decodes the snapshot file given as the first argument with the widget's own model and prints one summary line:
//   courses=<n> due=<n> new=<n> day=<day> first=<id>:<due>:<new>:<daysLeft|-> generatedAt=<unix seconds>
// Exit 1 and a message on stderr when it cannot be decoded. Built and run by tests/widget-swift.test.ts.

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write(Data("usage: decode-check <widget.json>\n".utf8))
    exit(2)
}
do {
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let snap = try WidgetSnapshot.decode(data)
    let first = snap.courses.first.map { "\($0.id):\($0.due):\($0.new):\($0.daysLeft.map(String.init) ?? "-")" } ?? "-"
    print("courses=\(snap.courses.count) due=\(snap.totals.due) new=\(snap.totals.new) day=\(snap.day) first=\(first) generatedAt=\(Int(snap.generatedAt.timeIntervalSince1970)) version=\(snap.version)")
} catch {
    FileHandle.standardError.write(Data("decode failed: \(error)\n".utf8))
    exit(1)
}
