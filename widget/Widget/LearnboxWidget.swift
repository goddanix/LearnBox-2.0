import SwiftUI
import WidgetKit

// Learnbox 2.0 widget: per course the cards due now, the new cards of the day and the days to the exam.
// It runs nothing: it draws widget.json, which the companion app's helper program keeps fresh.

enum LoadState {
    case snapshot(WidgetSnapshot)
    /// No widget.json yet: Learnbox 2.0 has not been started, or the helper has not run.
    case missing
    /// A file from a newer Learnbox than this widget understands.
    case unsupported

    static func load() -> LoadState {
        guard let data = try? Data(contentsOf: SnapshotFile.url()) else { return .missing }
        guard let snap = try? WidgetSnapshot.decode(data) else { return .unsupported }
        return snap.version == WidgetSnapshot.supportedVersion ? .snapshot(snap) : .unsupported
    }
}

struct LearnboxEntry: TimelineEntry {
    let date: Date
    let state: LoadState
}

extension WidgetSnapshot {
    /// What the widget gallery shows before anything is placed.
    static let sample = WidgetSnapshot(
        version: 1,
        generatedAt: Date(),
        day: "2026-11-06",
        courses: [
            WidgetCourse(id: "anatomie", name: "Anatomie", due: 42, new: 12, total: 900, deadline: "2026-12-04", daysLeft: 28),
            WidgetCourse(id: "physiologie", name: "Physiologie", due: 18, new: 8, total: 600, deadline: "2026-12-18", daysLeft: 42),
            WidgetCourse(id: "biochemie", name: "Biochemie", due: 5, new: 0, total: 300, deadline: nil, daysLeft: nil),
        ],
        totals: WidgetTotals(due: 65, new: 20)
    )
}

struct LearnboxProvider: TimelineProvider {
    func placeholder(in context: Context) -> LearnboxEntry { LearnboxEntry(date: Date(), state: .snapshot(.sample)) }

    func getSnapshot(in context: Context, completion: @escaping (LearnboxEntry) -> Void) {
        completion(LearnboxEntry(date: Date(), state: context.isPreview ? .snapshot(.sample) : .load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LearnboxEntry>) -> Void) {
        // The companion reloads the timeline when the numbers change; this is the fallback if it is not running.
        let entry = LearnboxEntry(date: Date(), state: .load())
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
    }
}

// MARK: - Views

private func examText(_ days: Int) -> String { days == 0 ? "exam today" : (days == 1 ? "1 day to exam" : "\(days) days to exam") }

private struct CourseRow: View {
    let course: WidgetCourse

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                Text(course.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                if let days = course.daysLeft {
                    Text(examText(days)).font(.caption2).foregroundStyle(days <= 7 ? Color.orange : Color.secondary)
                }
            }
            Spacer(minLength: 4)
            Text("\(course.due)").font(.subheadline.weight(.bold).monospacedDigit())
            Text("+\(course.new)").font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(.blue)
        }
    }
}

private struct Totals: View {
    let totals: WidgetTotals
    let big: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if totals.due + totals.new == 0 {
                Image(systemName: "checkmark.seal.fill").font(.system(size: big * 0.8)).foregroundStyle(.green)
                Text("All done").font(.subheadline.weight(.semibold))
            } else {
                Text("\(totals.due)")
                    .font(.system(size: big, weight: .bold, design: .rounded).monospacedDigit())
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                Text("due now").font(.caption).foregroundStyle(.secondary)
                Text("+\(totals.new) new").font(.caption.weight(.semibold)).foregroundStyle(.blue)
            }
        }
    }
}

private struct Header: View {
    var body: some View {
        Label("Learnbox 2.0", systemImage: "rectangle.stack.fill")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .labelStyle(.titleAndIcon)
    }
}

private struct Footer: View {
    let snapshot: WidgetSnapshot
    var body: some View {
        Text("Updated \(snapshot.generatedAt, style: .time)").font(.caption2).foregroundStyle(.tertiary)
    }
}

private struct Message: View {
    let title: String
    let detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Header()
            Spacer(minLength: 0)
            Text(title).font(.subheadline.weight(.semibold))
            Text(detail).font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

struct LearnboxWidgetView: View {
    @Environment(\.widgetFamily) private var environmentFamily
    let entry: LearnboxEntry
    /// Only the preview tool sets this (the widget family is read-only in the environment).
    var familyOverride: WidgetFamily? = nil

    private var family: WidgetFamily { familyOverride ?? environmentFamily }

    var body: some View {
        content
            .widgetURL(URL(string: "learnbox-widget://open"))
    }

    @ViewBuilder private var content: some View {
        switch entry.state {
        case .missing:
            Message(title: "No numbers yet", detail: "Start Learnbox 2.0 once, then they appear here.")
        case .unsupported:
            Message(title: "Widget out of date", detail: "Update Learnbox 2.0 Widget to the version that came with the app.")
        case .snapshot(let snap):
            switch family {
            case .systemSmall: small(snap)
            case .systemMedium: medium(snap)
            default: large(snap)
            }
        }
    }

    private func small(_ snap: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Header()
            Spacer(minLength: 0)
            Totals(totals: snap.totals, big: 44)
            if let next = snap.courses.first, snap.totals.due + snap.totals.new > 0 {
                Text(next.name).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func medium(_ snap: WidgetSnapshot) -> some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Header()
                Spacer(minLength: 0)
                Totals(totals: snap.totals, big: 40)
            }
            .frame(width: 96, alignment: .leading)
            VStack(alignment: .leading, spacing: 7) {
                ForEach(snap.courses.prefix(3)) { CourseRow(course: $0) }
                if snap.courses.isEmpty { Text("No courses yet").font(.caption).foregroundStyle(.secondary) }
                if snap.courses.count > 3 {
                    Text("+\(snap.courses.count - 3) more").font(.caption2).foregroundStyle(.tertiary)
                }
                Spacer(minLength: 0)
                Footer(snapshot: snap)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func large(_ snap: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Header()
                    Totals(totals: snap.totals, big: 40)
                }
                Spacer()
                Footer(snapshot: snap)
            }
            Divider()
            ForEach(snap.courses.prefix(8)) { CourseRow(course: $0) }
            if snap.courses.isEmpty { Text("No courses yet").font(.caption).foregroundStyle(.secondary) }
            if snap.courses.count > 8 {
                Text("+\(snap.courses.count - 8) more").font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct LearnboxWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "LearnboxWidget", provider: LearnboxProvider()) { entry in
            LearnboxWidgetView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Learnbox 2.0")
        .description("Cards due now and new cards per course, and the days to each exam.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// (the preview tool in widget/Tests builds this file with its own main.swift)
#if !WIDGET_PREVIEW_TOOL
@main
struct LearnboxWidgetBundle: WidgetBundle {
    var body: some Widget { LearnboxWidget() }
}
#endif
