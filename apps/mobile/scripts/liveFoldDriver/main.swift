// Folds plain slice JSON (argv) with targets/widgets/LiveSlices.swift and prints the summary,
// for widgets.live.slow.test.ts. An argument that isn't a slice stands for one the key can't open.
import Foundation

/// ActivityKit's type isn't on macOS; LiveSlices.swift only needs its shape.
struct PolarisActivityAttributes {
  struct ContentState { var v: Int; var slices: [String] }
}

let slices = CommandLine.arguments.dropFirst().map { json in
  try? JSONDecoder().decode(HostSlice.self, from: Data(json.utf8))
}
let summary = LiveSummary(slices: Array(slices))
let out: [String: Any] = [
  "hosts": summary.hosts,
  "working": summary.working,
  "since": summary.since.map { $0.timeIntervalSince1970 as Any } ?? NSNull(),
  "step": summary.step.map { step -> Any in
    ["host": step.host, "line": step.line.line, "harness": step.line.harness as Any? ?? NSNull()]
  } ?? NSNull(),
  "need": summary.need.map { need -> Any in ["host": need.host, "requestId": need.need.requestId] } ?? NSNull(),
  "needs": summary.needs,
  "celestials": summary.celestials.map { "\($0.harness)/\($0.body)" },
  "unreadable": summary.unreadable,
]
print(String(data: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
