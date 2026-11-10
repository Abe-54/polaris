import CoreMedia
import Foundation
import ScreenCaptureKit
import os

/// Receives one stream's frames on its own queue, drops the ones that show nothing new, and
/// writes the rest as JPEG. A slow reader blocks the queue, so ScreenCaptureKit drops frames.
final class FrameSink: NSObject, SCStreamOutput, SCStreamDelegate, Sendable {
  let queue = DispatchQueue(label: "dev.lux.polaris.capture.frames")
  private let window: UInt32
  private let output: Output
  private let onStop: @Sendable () -> Void
  private let deduper = OSAllocatedUnfairLock(initialState: FrameDeduper())

  init(window: UInt32, output: Output, onStop: @escaping @Sendable () -> Void) {
    self.window = window
    self.output = output
    self.onStop = onStop
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, Self.isComplete(sample), let buffer = CMSampleBufferGetImageBuffer(sample) else { return }
    let capturedAt = Date()

    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }

    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    let frame = UnsafeRawBufferPointer(start: base, count: bytesPerRow * height)

    // The pointer is only read inside the lock, while the pixel buffer stays locked.
    let jpeg = deduper.withLockUnchecked { deduper -> Data? in
      guard deduper.admit(frame, bytesPerRow: bytesPerRow, width: width, height: height) else { return nil }
      return Jpeg.encode(bgra: deduper.pixels, width: width, height: height)
    }

    guard let jpeg else { return }
    output.write(.frame(window: window, width: width, height: height, capturedAt: capturedAt, jpeg: jpeg))
  }

  func stream(_ stream: SCStream, didStopWithError error: any Error) {
    onStop()
  }

  /// ScreenCaptureKit marks a frame with nothing new `idle`; only `complete` ones carry pixels.
  private static func isComplete(_ sample: CMSampleBuffer) -> Bool {
    guard
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
        as? [[SCStreamFrameInfo: Any]],
      let raw = attachments.first?[.status] as? Int
    else { return false }
    return SCFrameStatus(rawValue: raw) == .complete
  }
}
