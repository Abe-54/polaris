import Foundation

/// What the Daemon asks for, one JSON object per line on stdin. `window` null stops capturing.
struct Command: Decodable, Equatable {
  var window: UInt32?
  /// The image's longer side, in pixels.
  var edge: Int?
  /// The most frames a second.
  var fps: Int?

  var target: Target? {
    guard let window else { return nil }
    return Target(window: window, edge: min(max(edge ?? 640, 16), 4096), fps: min(max(fps ?? 10, 1), 60))
  }

  init(line: String) throws {
    self = try JSONDecoder().decode(Command.self, from: Data(line.utf8))
  }
}

struct Target: Equatable {
  var window: UInt32
  var edge: Int
  var fps: Int
}

/// Why there is no frame now; the raw values are the protocol's `PreviewIdleReason`.
enum IdleReason: String {
  case noWindow = "no-window"
  case screenLocked = "screen-locked"
  case notReady = "not-ready"
}

/// One record on stdout: a JSON line, then for a frame its JPEG, `bytes` long.
enum Record {
  case frame(window: UInt32, width: Int, height: Int, capturedAt: Date, jpeg: Data)
  case idle(IdleReason)

  var encoded: Data {
    switch self {
    case .frame(let window, let width, let height, let capturedAt, let jpeg):
      let at = Int64((capturedAt.timeIntervalSince1970 * 1000).rounded())
      let header =
        "{\"frame\":{\"window\":\(window),\"width\":\(width),\"height\":\(height),\"capturedAt\":\(at),\"bytes\":\(jpeg.count)}}\n"
      return Data(header.utf8) + jpeg
    case .idle(let reason):
      return Data("{\"idle\":\"\(reason.rawValue)\"}\n".utf8)
    }
  }
}
