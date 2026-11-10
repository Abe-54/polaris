import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// A frame is at most this many bytes (the protocol's `PREVIEW_MAX_FRAME_BYTES`).
let maxFrameBytes = 512 * 1024

enum Jpeg {
  /// Tried in order until the image fits in `limit` bytes.
  static let qualities: [Double] = [0.7, 0.5, 0.3, 0.15]

  /// Encodes packed BGRA pixels (`width * 4` bytes a row). Nil when no quality fits `limit`.
  static func encode(bgra pixels: [UInt8], width: Int, height: Int, limit: Int = maxFrameBytes) -> Data? {
    guard width > 0, height > 0, pixels.count == width * height * 4,
      let provider = CGDataProvider(data: Data(pixels) as CFData),
      let space = CGColorSpace(name: CGColorSpace.sRGB),
      let image = CGImage(
        width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
        space: space,
        bitmapInfo: CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.noneSkipFirst.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { return nil }

    for quality in qualities {
      if let data = encode(image, quality: quality), data.count <= limit { return data }
    }
    return nil
  }

  private static func encode(_ image: CGImage, quality: Double) -> Data? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    return CGImageDestinationFinalize(destination) ? data as Data : nil
  }
}
