// The app's two themes for its extensions (widgets, a Live Activity): Midnight, the default, and
// Moonlit. Values are @polaris/ui's tokens and the horizon's ridges; widgets.theme.test.ts checks.
import Foundation
import SwiftUI

/// The theme the app last wrote to the App Group (`src/widgets/theme.ts`): "midnight" or "moonlit".
let themeKey = "polaris.theme"

/// A token as sRGB hex and an alpha, so the values read the same as in TypeScript.
struct ThemeColour: Equatable {
  let hex: UInt32
  let alpha: Double

  init(_ hex: UInt32, alpha: UInt32 = 0xFF) {
    self.hex = hex
    self.alpha = Double(alpha) / 255
  }

  var color: Color {
    Color(
      .sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255, opacity: alpha)
  }
}

struct ThemePalette: Equatable {
  let ground: ThemeColour
  let panel: ThemeColour
  let raised: ThemeColour
  let well: ThemeColour
  let hairline: ThemeColour
  let textStrong: ThemeColour
  let textDefault: ThemeColour
  let textSubtle: ThemeColour
  let textFaint: ThemeColour
  let starlight: ThemeColour
  let needsYou: ThemeColour
  let needsYouText: ThemeColour
  let failed: ThemeColour
  let failedText: ThemeColour
  let harnessClaudeCode: ThemeColour
  let harnessCodex: ThemeColour
  let harnessOpencode: ThemeColour
  /// The horizon's far and near ridges (apps/mobile/src/horizon/scene.ts).
  let ridgeBack: ThemeColour
  let ridgeFront: ThemeColour
}

enum PolarisTheme: String {
  case midnight
  case moonlit

  /// The app's choice, from the App Group's defaults; Midnight until the app has written one.
  static func current(_ defaults: UserDefaults?) -> PolarisTheme {
    defaults?.string(forKey: themeKey).flatMap(PolarisTheme.init(rawValue:)) ?? .midnight
  }

  var palette: ThemePalette {
    switch self {
    case .midnight: .midnight
    case .moonlit: .moonlit
    }
  }
}

extension ThemePalette {
  static let midnight = ThemePalette(
    ground: ThemeColour(0x000000),
    panel: ThemeColour(0x0A0B0D),
    raised: ThemeColour(0x141518),
    well: ThemeColour(0x0E0F12),
    hairline: ThemeColour(0xFFFFFF, alpha: 0x14),
    textStrong: ThemeColour(0xF4F5F7),
    textDefault: ThemeColour(0xE3E4E8),
    textSubtle: ThemeColour(0x9A9CA4),
    textFaint: ThemeColour(0x686A72),
    starlight: ThemeColour(0xBCD3FF),
    needsYou: ThemeColour(0xF2C84B),
    needsYouText: ThemeColour(0xF2C84B),
    failed: ThemeColour(0xF0645A),
    failedText: ThemeColour(0xF37B72),
    harnessClaudeCode: ThemeColour(0xD97757),
    harnessCodex: ThemeColour(0x6FCBA0),
    harnessOpencode: ThemeColour(0xE59AC1),
    ridgeBack: ThemeColour(0x151A3A),
    ridgeFront: ThemeColour(0x0B1026)
  )

  static let moonlit = ThemePalette(
    ground: ThemeColour(0x151618),
    panel: ThemeColour(0x1A1B1D),
    raised: ThemeColour(0x26272B),
    well: ThemeColour(0x222327),
    hairline: ThemeColour(0xFFFFFF, alpha: 0x0F),
    textStrong: ThemeColour(0xF4F5F7),
    textDefault: ThemeColour(0xE3E4E8),
    textSubtle: ThemeColour(0x9A9CA4),
    textFaint: ThemeColour(0x686A72),
    starlight: ThemeColour(0xBCD3FF),
    needsYou: ThemeColour(0xF2C84B),
    needsYouText: ThemeColour(0xF2C84B),
    failed: ThemeColour(0xF0645A),
    failedText: ThemeColour(0xF37B72),
    harnessClaudeCode: ThemeColour(0xD97757),
    harnessCodex: ThemeColour(0x6FCBA0),
    harnessOpencode: ThemeColour(0xE59AC1),
    ridgeBack: ThemeColour(0x262B45),
    ridgeFront: ThemeColour(0x1E2236)
  )
}
