import AppKit
import CoreGraphics
import Foundation

/// polaris-capture: live JPEG frames of one window, for the computer use preview (ENG-846).
/// The Daemon starts it inside Polaris Computer Use.app only while a Client watches, names the
/// window on stdin, and closes stdin when the last one stops: this process then exits.
@main
enum Main {
  @MainActor
  static func main() async {
    signal(SIGPIPE, SIG_IGN)
    // ScreenCaptureKit asserts in a tool with no window server connection; this makes one.
    _ = NSApplication.shared
    let (events, continuation) = AsyncStream.makeStream(of: Event.self)
    let capture = Capture(output: Output(), events: continuation, locked: screenIsLocked())

    // Lives as long as the process: stdin closing is what ends it.
    Task {
      do {
        for try await line in FileHandle.standardInput.bytes.lines {
          if let command = try? Command(line: line) { continuation.yield(.command(command)) }
        }
      } catch {}
      continuation.yield(.end)
    }

    let center = DistributedNotificationCenter.default()
    let observers = [("com.apple.screenIsLocked", true), ("com.apple.screenIsUnlocked", false)].map { name, locked in
      center.addObserver(forName: Notification.Name(name), object: nil, queue: nil) { _ in
        continuation.yield(.screenLocked(locked))
      }
    }
    defer { observers.forEach(center.removeObserver) }

    for await event in events {
      await capture.handle(event)
      if case .end = event { break }
    }
    exit(0)
  }

  private static func screenIsLocked() -> Bool {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    return session?["CGSSessionScreenIsLocked"] as? Bool ?? false
  }
}
