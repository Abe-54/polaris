import AppKit
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

/// What can happen to this process, handled one at a time in arrival order.
enum Event: Sendable {
  case command(Command)
  case screenLocked(Bool)
  /// The stream numbered `generation` stopped by itself: its window closed.
  case stopped(generation: Int)
  /// stdin closed: the Daemon has no more watchers, or is gone.
  case end
}

/// Captures the targeted window while there is one, the screen is unlocked and macOS allows it.
@MainActor
final class Capture {
  private let output: Output
  private let events: AsyncStream<Event>.Continuation
  private var target: Target?
  private var locked: Bool
  private var running: (stream: SCStream, sink: FrameSink, target: Target)?
  private var generation = 0

  init(output: Output, events: AsyncStream<Event>.Continuation, locked: Bool) {
    self.output = output
    self.events = events
    self.locked = locked
  }

  func handle(_ event: Event) async {
    switch event {
    case .command(let command):
      target = command.target
      // The same target again restarts a stream that stopped; a running one is left alone.
      if running?.target != target || target == nil { await restart() }
    case .screenLocked(let locked):
      self.locked = locked
      if target != nil { await restart() }
    case .stopped(let generation):
      guard generation == self.generation, running != nil else { return }
      running = nil
      output.write(.idle(.noWindow))
    case .end:
      await stop()
    }
  }

  private func stop() async {
    guard let running else { return }
    self.running = nil
    generation += 1
    try? await ScreenCapture.stop(running.stream)
  }

  private func restart() async {
    await stop()
    guard let target else { return output.write(.idle(.noWindow)) }
    guard !locked else { return output.write(.idle(.screenLocked)) }
    // Asking for the window list without the permission would raise the system prompt.
    guard CGPreflightScreenCaptureAccess() else {
      output.write(.idle(.notReady))
      exit(ExitCode.notReady)
    }

    // ScreenCaptureKit asserts (CGS_REQUIRE_INIT) in a tool that never connected to the
    // window server; AppKit connects. Only once the grant is known, so a refusal stays quiet.
    _ = NSApplication.shared

    do {
      let content = try await ScreenCapture.content()
      guard let window = content.windows.first(where: { $0.windowID == target.window }) else {
        return output.write(.idle(.noWindow))
      }

      generation += 1
      let generation = generation
      let events = events
      let sink = FrameSink(window: target.window, output: output) { events.yield(.stopped(generation: generation)) }
      let filter = SCContentFilter(desktopIndependentWindow: window)
      let stream = SCStream(filter: filter, configuration: Self.configuration(for: window, filter: filter, target: target), delegate: sink)
      try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: sink.queue)
      try await ScreenCapture.start(stream)
      running = (stream, sink, target)
    } catch {
      output.write(.idle(.noWindow))
    }
  }

  /// The window scaled so its longer side is `target.edge` pixels, never enlarged.
  private static func configuration(for window: SCWindow, filter: SCContentFilter, target: Target) -> SCStreamConfiguration {
    let scale: CGFloat = if #available(macOS 14.0, *) { CGFloat(filter.pointPixelScale) } else { 1 }
    let size = fit(width: window.frame.width * scale, height: window.frame.height * scale, edge: target.edge)

    let configuration = SCStreamConfiguration()
    configuration.width = size.width
    configuration.height = size.height
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(target.fps))
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.colorSpaceName = CGColorSpace.sRGB
    configuration.showsCursor = false
    configuration.queueDepth = 3
    if #available(macOS 14.0, *) { configuration.ignoreShadowsSingleWindow = true }
    return configuration
  }
}

/// Carries a ScreenCaptureKit object out of its completion handler: the SDK marks none Sendable.
private struct Carried<Value>: @unchecked Sendable {
  let value: Value
}

/// ScreenCaptureKit's completion-handler calls, awaited without leaving the main actor. Swift
/// 6.1 (Xcode 16) refuses the SDK's own async forms, which hand non-Sendable objects across.
@MainActor
enum ScreenCapture {
  static func content() async throws -> SCShareableContent {
    let carried: Carried<SCShareableContent> = try await withCheckedThrowingContinuation { continuation in
      SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
        if let content {
          continuation.resume(returning: Carried(value: content))
        } else {
          continuation.resume(throwing: error ?? CocoaError(.featureUnsupported))
        }
      }
    }
    return carried.value
  }

  static func start(_ stream: SCStream) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      stream.startCapture { error in Self.finish(continuation, error) }
    }
  }

  static func stop(_ stream: SCStream) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      stream.stopCapture { error in Self.finish(continuation, error) }
    }
  }

  private nonisolated static func finish(_ continuation: CheckedContinuation<Void, any Error>, _ error: (any Error)?) {
    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
  }
}

/// `width` by `height` scaled down so its longer side is at most `edge`; each side at least 1.
func fit(width: CGFloat, height: CGFloat, edge: Int) -> (width: Int, height: Int) {
  let longer = max(width, height, 1)
  let ratio = min(1, CGFloat(edge) / longer)
  return (max(1, Int((width * ratio).rounded())), max(1, Int((height * ratio).rounded())))
}

enum ExitCode {
  /// macOS has not granted Screen Recording to Polaris Computer Use.app.
  static let notReady: Int32 = 3
}
