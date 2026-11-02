// Drives targets/widgets/Snapshot.swift for widgets.swift.slow.test.ts: argv[1] is the app's snapshot
// JSON, argv[2] the push extension's records, argv[3] "now" in ms; prints what the widgets draw.
import Foundation

let arguments = CommandLine.arguments
let snapshot = decodeSnapshot(arguments[1].data(using: .utf8))
let pushes = decodePushes(arguments[2].data(using: .utf8))
let now = Date(timeIntervalSince1970: (Double(arguments[3]) ?? 0) / 1000)

struct Drawn: Encodable {
  let snapshot: WidgetSnapshot?
  let inline: String?
  let trailing: [String]
}

let merged = snapshot.map { merge($0, pushes: pushes) }
let drawn = Drawn(
  snapshot: merged, inline: merged.map { $0.summary.map(\.text).joined(separator: " · ") },
  trailing: merged?.rows.map { trailing($0, now: now) } ?? [])
print(String(data: try JSONEncoder().encode(drawn), encoding: .utf8)!)
