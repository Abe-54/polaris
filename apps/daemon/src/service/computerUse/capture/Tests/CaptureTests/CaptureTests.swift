import CoreGraphics
import Foundation
import ImageIO
import Testing

@testable import polaris_capture

/// A `width` by `height` frame with `padding` junk bytes after each row, as CoreVideo pads rows.
private func frame(width: Int, height: Int, padding: Int, pixel: UInt8, junk: UInt8) -> (bytes: [UInt8], bytesPerRow: Int) {
  let bytesPerRow = width * 4 + padding
  var bytes = [UInt8](repeating: junk, count: bytesPerRow * height)
  for row in 0..<height {
    for column in 0..<(width * 4) { bytes[row * bytesPerRow + column] = pixel }
  }
  return (bytes, bytesPerRow)
}

private func admit(_ deduper: inout FrameDeduper, _ frame: (bytes: [UInt8], bytesPerRow: Int), width: Int, height: Int) -> Bool {
  frame.bytes.withUnsafeBytes { deduper.admit($0, bytesPerRow: frame.bytesPerRow, width: width, height: height) }
}

@Suite struct FrameDeduperTests {
  @Test func `the first frame is new and the same pixels again are not`() {
    var deduper = FrameDeduper()
    let first = frame(width: 8, height: 4, padding: 0, pixel: 10, junk: 0)
    #expect(admit(&deduper, first, width: 8, height: 4))
    #expect(!admit(&deduper, first, width: 8, height: 4))
  }

  @Test func `row padding that differs does not make a frame new`() {
    var deduper = FrameDeduper()
    #expect(admit(&deduper, frame(width: 8, height: 4, padding: 12, pixel: 10, junk: 1), width: 8, height: 4))
    #expect(!admit(&deduper, frame(width: 8, height: 4, padding: 12, pixel: 10, junk: 200), width: 8, height: 4))
  }

  @Test(arguments: [0, 17, 8 * 4 * 4 - 1])
  func `one changed byte anywhere is a new frame, kept whole`(offset: Int) {
    var deduper = FrameDeduper()
    var next = frame(width: 8, height: 4, padding: 0, pixel: 10, junk: 0)
    #expect(admit(&deduper, next, width: 8, height: 4))
    next.bytes[offset] = 11
    #expect(admit(&deduper, next, width: 8, height: 4))
    #expect(deduper.pixels == next.bytes)
    #expect(!admit(&deduper, next, width: 8, height: 4))
  }

  @Test func `a new size is a new frame even with the same bytes`() {
    var deduper = FrameDeduper()
    #expect(admit(&deduper, frame(width: 8, height: 4, padding: 0, pixel: 10, junk: 0), width: 8, height: 4))
    #expect(admit(&deduper, frame(width: 4, height: 8, padding: 0, pixel: 10, junk: 0), width: 4, height: 8))
  }

  @Test func `padded rows are packed`() {
    var deduper = FrameDeduper()
    #expect(admit(&deduper, frame(width: 2, height: 2, padding: 3, pixel: 7, junk: 99), width: 2, height: 2))
    #expect(deduper.pixels == [UInt8](repeating: 7, count: 16))
  }
}

@Suite struct WireTests {
  @Test func `a command names the window, edge and rate`() throws {
    let command = try Command(line: #"{"window":4242,"edge":640,"fps":10}"#)
    #expect(command.target == Target(window: 4242, edge: 640, fps: 10))
  }

  @Test func `a null window is no target`() throws {
    #expect(try Command(line: #"{"window":null}"#).target == nil)
  }

  @Test func `the rate and edge are clamped`() throws {
    let command = try Command(line: #"{"window":1,"edge":100000,"fps":0}"#)
    #expect(command.target == Target(window: 1, edge: 4096, fps: 1))
  }

  @Test func `a frame record is its header line then exactly its bytes`() throws {
    let jpeg = Data([0xFF, 0xD8, 0x0A, 0xFF, 0xD9])
    let encoded = Record.frame(window: 7, width: 640, height: 417, capturedAt: Date(timeIntervalSince1970: 1.5), jpeg: jpeg).encoded
    let newline = try #require(encoded.firstIndex(of: 0x0A))
    let header = try JSONSerialization.jsonObject(with: encoded[..<newline]) as? [String: [String: Int]]
    #expect(header == ["frame": ["window": 7, "width": 640, "height": 417, "capturedAt": 1500, "bytes": 5]])
    #expect(encoded[(newline + 1)...] == jpeg)
  }

  @Test func `an idle record names the protocol's reason`() {
    #expect(String(decoding: Record.idle(.screenLocked).encoded, as: UTF8.self) == "{\"idle\":\"screen-locked\"}\n")
  }
}

@Suite struct JpegTests {
  /// Noise does not compress, so it needs the lower qualities to fit a small limit.
  private static func noise(width: Int, height: Int) -> [UInt8] {
    var generator = SystemRandomNumberGenerator()
    return (0..<(width * height * 4)).map { _ in UInt8.random(in: 0...255, using: &generator) }
  }

  private static func size(of jpeg: Data) -> (Int, Int)? {
    guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { return nil }
    return (image.width, image.height)
  }

  @Test func `the image decodes at the frame's size`() throws {
    let jpeg = try #require(Jpeg.encode(bgra: [UInt8](repeating: 128, count: 64 * 32 * 4), width: 64, height: 32))
    let size = try #require(Self.size(of: jpeg))
    #expect(size == (64, 32))
  }

  @Test func `quality drops until the image fits the limit`() throws {
    let pixels = Self.noise(width: 256, height: 256)
    let full = try #require(Jpeg.encode(bgra: pixels, width: 256, height: 256))
    let limit = full.count * 2 / 3
    let fitted = try #require(Jpeg.encode(bgra: pixels, width: 256, height: 256, limit: limit))
    #expect(fitted.count <= limit)
  }

  @Test func `an image no quality fits is not sent`() {
    #expect(Jpeg.encode(bgra: Self.noise(width: 256, height: 256), width: 256, height: 256, limit: 64) == nil)
  }
}

@Suite struct FitTests {
  @Test(arguments: [
    (2032.0, 1106.0, 640, 640, 348),
    (400.0, 1000.0, 640, 256, 640),
    (300.0, 200.0, 640, 300, 200),
    (5000.0, 1.0, 640, 640, 1),
  ])
  func `the longer side fits the edge and nothing is enlarged`(width: Double, height: Double, edge: Int, w: Int, h: Int) {
    let size = fit(width: width, height: height, edge: edge)
    #expect(size == (w, h))
  }
}
