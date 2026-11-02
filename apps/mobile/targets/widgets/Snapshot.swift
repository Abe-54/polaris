// What the widgets show, as the app writes it (apps/mobile/src/widgets/snapshot.ts) and R5's
// Notification Service Extension adds to. Foundation only: scripts/widgets.swift.slow.test.ts runs it.
import Foundation

/// Also in app.json's entitlements and apps/mobile/src/widgets/publish.ts.
let appGroup = "group.dev.lux.polaris"
let snapshotKey = "polaris.widgets.snapshot"
/// Written by the Notification Service Extension (R5): opened pushes, newest first.
let pushKey = "polaris.push.recent"
let snapshotVersion = 1
let rowLimit = 3
let homeLink = "polaris://home"

struct SummaryPart: Codable, Equatable {
  let text: String
  /// "needs-you", "subtle" or "faint".
  let tone: String
}

struct WidgetRow: Codable, Equatable {
  let hostId: String
  let sessionId: String
  let title: String
  let harness: String
  /// "needs-you", "working", "starting", "failed" or "done".
  let glyph: String
  let turn: Int?
  /// Milliseconds since the epoch.
  let since: Double?
  let link: String
}

struct WidgetSnapshot: Codable, Equatable {
  let version: Int
  let needsYou: Int
  let working: Int
  let summary: [SummaryPart]
  let rows: [WidgetRow]
  let empty: String?
  let stale: Bool
  let link: String
  /// Milliseconds since the epoch.
  let writtenAt: Double
}

struct PushRecord: Codable, Equatable {
  let kind: String
  let hostId: String
  let hostName: String
  let sessionId: String
  let requestId: String?
  let subtitle: String
  let at: String
}

/// The snapshot, or nil when there is none or its version is one this extension doesn't know.
func decodeSnapshot(_ data: Data?) -> WidgetSnapshot? {
  guard let data, let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data),
    snapshot.version == snapshotVersion
  else { return nil }
  return snapshot
}

func decodePushes(_ data: Data?) -> [PushRecord] {
  guard let data else { return [] }
  return (try? JSONDecoder().decode([PushRecord].self, from: data)) ?? []
}

private func parseDate(_ text: String) -> Date? {
  let precise = ISO8601DateFormatter()
  precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return precise.date(from: text) ?? ISO8601DateFormatter().date(from: text)
}

/// Must match `sessionLink` in apps/mobile/src/widgets/links.ts.
func sessionLink(hostId: String, sessionId: String) -> String {
  var allowed = CharacterSet.alphanumerics
  allowed.insert(charactersIn: "-_.!~*'()")
  let encode = { (part: String) in
    part.addingPercentEncoding(withAllowedCharacters: allowed) ?? part
  }
  return "polaris://session/\(encode(hostId))/\(encode(sessionId))"
}

/// Needs you pushes that arrived after the app last wrote the snapshot are counted and listed
/// until the app writes again; one per agent session.
func merge(_ snapshot: WidgetSnapshot, pushes: [PushRecord]) -> WidgetSnapshot {
  let written = Date(timeIntervalSince1970: snapshot.writtenAt / 1000)
  let askingAlready = Set(
    snapshot.rows.filter { $0.glyph == "needs-you" }.map { "\($0.hostId)/\($0.sessionId)" })
  var seen = Set<String>()
  var fresh: [WidgetRow] = []
  for push in pushes where push.kind == "needs-you" {
    let key = "\(push.hostId)/\(push.sessionId)"
    guard let at = parseDate(push.at), at > written, !askingAlready.contains(key),
      seen.insert(key).inserted
    else { continue }
    fresh.append(
      WidgetRow(
        hostId: push.hostId, sessionId: push.sessionId,
        title: push.subtitle.isEmpty ? "Untitled agent session" : push.subtitle,
        harness: "", glyph: "needs-you", turn: nil, since: at.timeIntervalSince1970 * 1000,
        link: sessionLink(hostId: push.hostId, sessionId: push.sessionId)))
  }
  guard !fresh.isEmpty else { return snapshot }
  let freshKeys = Set(fresh.map { "\($0.hostId)/\($0.sessionId)" })
  let others = snapshot.rows.filter { !freshKeys.contains("\($0.hostId)/\($0.sessionId)") }
  let asking = others.filter { $0.glyph == "needs-you" }
  let rest = others.filter { $0.glyph != "needs-you" }
  let needsYou = snapshot.needsYou + fresh.count
  // A fresh needs you replaces "Nothing needs you" / "No hosts yet" but keeps the other parts.
  let kept = snapshot.summary.filter {
    $0.tone != "needs-you" && !(snapshot.needsYou == 0 && snapshot.working == 0 && $0.tone == "subtle")
  }
  return WidgetSnapshot(
    version: snapshot.version, needsYou: needsYou, working: snapshot.working,
    summary: [SummaryPart(text: "\(needsYou) need you", tone: "needs-you")] + kept,
    rows: Array((asking + fresh + rest).prefix(rowLimit)), empty: nil, stale: snapshot.stale,
    link: snapshot.link, writtenAt: snapshot.writtenAt)
}

/// "now", "42m", "3h", "2d"; must match `age` in apps/mobile/src/home/model/format.ts.
func age(since: Double, now: Date) -> String {
  let elapsed = max(0, now.timeIntervalSince1970 * 1000 - since)
  let minute = 60_000.0
  if elapsed < minute { return "now" }
  if elapsed < 60 * minute { return "\(Int(elapsed / minute))m" }
  if elapsed < 24 * 60 * minute { return "\(Int(elapsed / (60 * minute)))h" }
  return "\(Int(elapsed / (24 * 60 * minute)))d"
}

/// What a row says on its right: its age, or its turn while it works.
func trailing(_ row: WidgetRow, now: Date) -> String {
  if let turn = row.turn { return "turn \(turn)" }
  if let since = row.since { return age(since: since, now: now) }
  return ""
}

/// The snapshot the widgets draw, from the App Group's defaults.
func loadSnapshot(_ defaults: UserDefaults?) -> WidgetSnapshot? {
  guard let defaults, let snapshot = decodeSnapshot(defaults.string(forKey: snapshotKey)?.data(using: .utf8))
  else { return nil }
  let pushes = defaults.string(forKey: pushKey)?.data(using: .utf8) ?? defaults.data(forKey: pushKey)
  return merge(snapshot, pushes: decodePushes(pushes))
}
