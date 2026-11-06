import Foundation

// The widget's numbers: what scripts/widget-helper.ts (core/widget-snapshot.ts) writes to
// ~/Library/Application Support/Learnbox/widget/widget.json. Keep in step with WidgetSnapshot there; the format is
// versioned, and tests/widget-swift.test.ts decodes a real snapshot with this very file.

struct WidgetCourse: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    /// Cards to answer now (learning + review).
    let due: Int
    /// New cards on offer today.
    let new: Int
    let total: Int
    /// Exam day "YYYY-MM-DD", when the course has one.
    let deadline: String?
    /// Days to the exam while it is active, else nil.
    let daysLeft: Int?
}

struct WidgetTotals: Codable, Hashable {
    let due: Int
    let new: Int
}

struct WidgetSnapshot: Codable, Hashable {
    static let supportedVersion = 1

    let version: Int
    let generatedAt: Date
    /// The study day "YYYY-MM-DD" (it rolls over at 04:00).
    let day: String
    let courses: [WidgetCourse]
    let totals: WidgetTotals

    /// The helper writes JavaScript ISO times: "2026-11-06T07:44:24.730Z".
    static func decode(_ data: Data) throws -> WidgetSnapshot {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            if let date = fractional.date(from: text) ?? plain.date(from: text) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not an ISO date: \(text)"))
        }
        return try decoder.decode(WidgetSnapshot.self, from: data)
    }
}

enum SnapshotFile {
    /// The real home folder. A sandboxed process gets a container as $HOME, but getpwuid still names the real one.
    static func realHome() -> String {
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir { return String(cString: dir) }
        return NSHomeDirectory()
    }

    /// The folder the widget's sandbox exception allows (see widget/Widget/widget.entitlements).
    static let folderInSupport = "Library/Application Support/Learnbox/widget"

    static func url(home: String = realHome()) -> URL {
        URL(fileURLWithPath: home).appendingPathComponent(folderInSupport).appendingPathComponent("widget.json")
    }
}
