import Foundation

/// Remembers the last frame's pixels, so a frame that shows nothing new is never encoded or sent.
/// ScreenCaptureKit delivers frames at the cap even for a window that does not change.
struct FrameDeduper {
  /// The last admitted frame, rows packed with no padding: `width * 4` bytes each.
  private(set) var pixels: [UInt8] = []
  private(set) var width = 0
  private(set) var height = 0

  /// Takes a 4-bytes-a-pixel frame whose rows are `bytesPerRow` apart. True when it differs from
  /// the last one, which it then replaces. Bytes past `width * 4` in a row are padding, ignored.
  mutating func admit(_ frame: UnsafeRawBufferPointer, bytesPerRow: Int, width: Int, height: Int) -> Bool {
    let rowBytes = width * 4
    precondition(bytesPerRow >= rowBytes && frame.count >= bytesPerRow * (height - 1) + rowBytes)
    guard let base = frame.baseAddress, rowBytes > 0, height > 0 else { return false }

    let resized = width != self.width || height != self.height
    if resized {
      pixels = [UInt8](repeating: 0, count: rowBytes * height)
      self.width = width
      self.height = height
    }

    var changed = resized
    pixels.withUnsafeMutableBytes { kept in
      guard let keptBase = kept.baseAddress else { return }
      for row in 0..<height {
        let source = base + row * bytesPerRow
        let last = keptBase + row * rowBytes
        if changed || memcmp(last, source, rowBytes) != 0 {
          changed = true
          memcpy(last, source, rowBytes)
        }
      }
    }
    return changed
  }
}
