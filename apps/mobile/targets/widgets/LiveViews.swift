// The aggregate Live Activity's views (Paper "Mobile chrome exploration" MX-AZ and MX-BA): the
// working summary over the horizon strip, and the Needs You takeover with its answers.
import AppIntents
import SwiftUI

/// Copy the activity shows; widgets.live.slow.test.ts checks it through the driver.
enum LiveCopy {
  static func working(_ count: Int) -> String { count == 0 ? "Nothing working" : "\(count) working" }

  static func hosts(_ count: Int) -> String { count == 1 ? "Polaris · 1 host" : "Polaris · \(count) hosts" }

  static func needsYou(_ harness: String?) -> String {
    guard let harness, !harness.isEmpty else { return "An agent session needs you" }
    return "\(harness) needs you"
  }

  static func more(_ needs: Int) -> String? { needs > 1 ? "+\(needs - 1) more" : nil }

  static let unreadable = "Open Polaris to see every host"
  static let answerInApp = "Answer in Polaris"
}

private func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
  .system(size: size, weight: weight, design: .monospaced)
}

/// Paper's four-point star, in a 12 grid: the Needs You mark (amber) and the Polaris mark.
struct LiveStar: Shape {
  func path(in rect: CGRect) -> Path {
    let s = min(rect.width, rect.height) / 12
    let points: [(CGFloat, CGFloat)] = [
      (6, 0.5), (7.1, 4.9), (11.5, 6), (7.1, 7.1), (6, 11.5), (4.9, 7.1), (0.5, 6), (4.9, 4.9),
    ]
    var path = Path()
    path.addLines(points.map { CGPoint(x: rect.minX + $0.0 * s, y: rect.minY + $0.1 * s) })
    path.closeSubpath()
    return path
  }
}

/// A working session's celestial, in its Harness's hue or its own (LiveCelestials.swift).
struct LiveCelestialView: View {
  let celestial: LiveCelestial?

  var body: some View {
    Canvas { context, canvas in
      let runs = liveBodies[celestial?.body ?? "ringed"] ?? liveBodies["ringed"] ?? []
      let tones =
        celestial.flatMap { liveBodyTones[$0.body] ?? liveHarnessTones[$0.harness] }
        ?? liveNeutralTones
      let unit = min(canvas.width, canvas.height) / 16
      for at in stride(from: 0, to: runs.count - 3, by: 4) {
        let rect = CGRect(
          x: CGFloat(runs[at]) * unit, y: CGFloat(runs[at + 1]) * unit,
          width: CGFloat(runs[at + 2]) * unit, height: unit)
        context.fill(Path(rect), with: .color(ThemeColour(tones[Int(runs[at + 3])]).color))
      }
    }
  }
}

/// One celestial per working session, at most three; a neutral one while none is known.
struct LiveCelestials: View {
  let summary: LiveSummary
  let size: CGFloat

  var body: some View {
    let shown = summary.celestials.isEmpty ? [nil] : summary.celestials.map(Optional.some)
    HStack(spacing: size / 6) {
      ForEach(Array(shown.enumerated()), id: \.offset) { _, celestial in
        LiveCelestialView(celestial: celestial).frame(width: size, height: size)
      }
    }
  }
}

/// Time since the longest-running Turn began, kept current by the system without updates:
/// "18 minutes" (iOS 18) or, compact and on iOS 17, a "18:04" timer. SwiftUI has no "18m".
struct LiveElapsed: View {
  let since: Date?
  var compact = false

  var body: some View {
    if let since {
      if #available(iOS 18.0, *), !compact {
        Text(.currentDate, format: .offset(to: since, allowedFields: [.hour, .minute], maxFieldCount: 1, sign: .never))
      } else {
        Text(timerInterval: since...since.addingTimeInterval(7 * 86_400), countsDown: false)
          .monospacedDigit()
      }
    }
  }
}

/// The ridges at the card's foot, as Home's horizon (MX-AZ), in the theme's ridge colours.
struct LiveHorizon: View {
  let palette: ThemePalette

  private static let back: [(CGFloat, CGFloat)] = [
    (12, 23), (36, 21), (48, 20), (72, 24), (84, 26), (96, 24), (144, 26), (156, 28), (168, 30),
    (180, 26), (192, 22), (204, 24), (216, 22), (228, 24), (240, 22), (252, 24), (276, 28),
    (288, 26), (300, 24), (312, 26), (324, 30), (336, 34), (348, 32), (384, 30), (393, 34),
  ]
  private static let front: [(CGFloat, CGFloat)] = [
    (12, 56), (20, 54), (28, 58), (36, 56), (44, 58), (60, 60), (68, 62), (84, 64), (92, 60),
    (100, 56), (116, 58), (132, 54), (140, 56), (148, 54), (156, 52), (164, 54), (172, 52),
    (188, 50), (212, 54), (228, 58), (236, 60), (244, 58), (252, 60), (276, 64), (292, 60),
    (300, 64), (316, 62), (324, 60), (332, 62), (372, 64), (380, 62), (388, 60), (393, 56),
  ]

  private static let stars: [(CGFloat, CGFloat, Double)] = [(52, 2, 0.5), (236, 1, 0.35), (318, 4, 0.45)]

  private struct Ridge: Shape {
    let steps: [(CGFloat, CGFloat)]
    /// Paper's y for the strip's top: the far ridge crests at once, the near one lower.
    let base: CGFloat

    func path(in rect: CGRect) -> Path {
      let scale = rect.width / 393
      var path = Path()
      var x: CGFloat = 0
      path.move(to: CGPoint(x: 0, y: rect.maxY))
      for (to, top) in steps {
        path.addLine(to: CGPoint(x: x * scale, y: rect.minY + (top - base) * 0.6))
        path.addLine(to: CGPoint(x: to * scale, y: rect.minY + (top - base) * 0.6))
        x = to
      }
      path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
      path.closeSubpath()
      return path
    }
  }

  var body: some View {
    ZStack(alignment: .topLeading) {
      LinearGradient(
        colors: [ThemeColour(0x465CBE, alpha: 0x29).color, .clear], startPoint: .bottom, endPoint: .top)
      Ridge(steps: Self.back, base: 16).fill(palette.ridgeBack.color)
      Ridge(steps: Self.front, base: 34).fill(palette.ridgeFront.color)
      ForEach(Array(Self.stars.enumerated()), id: \.offset) { _, star in
        Rectangle().fill(palette.starlight.color.opacity(star.2)).frame(width: 1.5, height: 1.5)
          .offset(x: star.0, y: star.1)
      }
    }
    .opacity(0.8)
    .frame(height: 28)
    .clipped()
  }
}

/// MX-AZ: what's working on every followed host.
struct LiveWorking: View {
  let summary: LiveSummary
  let palette: ThemePalette
  var header = true

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if header {
        HStack(spacing: 7) {
          LiveStar().fill(palette.starlight.color).frame(width: 11, height: 11)
          Text(LiveCopy.hosts(summary.hosts + summary.unreadable))
            .font(.system(size: 13)).foregroundStyle(palette.textSubtle.color)
          Spacer(minLength: 8)
          LiveElapsed(since: summary.since)
            .font(mono(13)).foregroundStyle(palette.textSubtle.color).frame(maxWidth: 120, alignment: .trailing)
        }
      }
      HStack(spacing: 10) {
        LiveCelestials(summary: summary, size: 24)
        Text(LiveCopy.working(summary.working))
          .font(.system(size: 22, weight: .semibold)).foregroundStyle(palette.textStrong.color)
          .lineLimit(1).minimumScaleFactor(0.8).layoutPriority(1)
        if !header {
          Spacer(minLength: 8)
          LiveElapsed(since: summary.since)
            .font(mono(13)).foregroundStyle(palette.textSubtle.color).frame(maxWidth: 120, alignment: .trailing)
        }
      }
      if let (_, _, step) = summary.step {
        VStack(alignment: .leading, spacing: 2) {
          Text(step.session).font(.system(size: 14)).foregroundStyle(palette.textDefault.color)
            .lineLimit(1)
          Text(step.line).font(mono(12)).foregroundStyle(palette.textSubtle.color).lineLimit(1)
        }
      }
      if summary.unreadable > 0 {
        Text(LiveCopy.unreadable).font(.system(size: 13)).foregroundStyle(palette.textSubtle.color)
      }
    }
  }
}

/// MX-BA: the Needs You takeover, answered from the lock screen or the island.
struct LiveTakeover: View {
  let host: (id: String, name: String)
  let need: LiveNeed
  let needs: Int
  let palette: ThemePalette

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        LiveStar().fill(palette.needsYou.color).frame(width: 18, height: 18)
        Text(LiveCopy.needsYou(need.harness))
          .font(.system(size: 17, weight: .semibold)).foregroundStyle(palette.needsYouText.color)
          .lineLimit(1).minimumScaleFactor(0.8)
        Spacer(minLength: 8)
        if let more = LiveCopy.more(needs) {
          Text(more).font(mono(13)).foregroundStyle(palette.textSubtle.color).fixedSize()
        }
      }
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Text(need.session).font(.system(size: 15)).foregroundStyle(palette.textDefault.color).lineLimit(1)
          Spacer(minLength: 0)
          // A long host name gives way in the middle, so the session title keeps most of the row.
          Text(host.name).font(mono(13)).foregroundStyle(palette.textSubtle.color).lineLimit(1)
            .truncationMode(.middle).frame(maxWidth: 132, alignment: .trailing).layoutPriority(1)
        }
        Text(need.line).font(mono(13)).foregroundStyle(palette.textDefault.color).lineLimit(2)
          .padding(.horizontal, 12).padding(.vertical, 8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(palette.well.color, in: RoundedRectangle(cornerRadius: 12))
      }
      LiveAnswers(hostId: host.id, need: need, palette: palette)
    }
  }
}

private struct LiveAnswers: View {
  let hostId: String
  let need: LiveNeed
  let palette: ThemePalette

  private func pill(_ title: String, _ text: ThemeColour, _ fill: ThemeColour) -> some View {
    Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(text.color).lineLimit(1)
      .frame(maxWidth: .infinity, minHeight: 40)
      .background(fill.color, in: Capsule())
  }

  private func answer(_ decision: LiveDecision) -> LiveAnswerIntent {
    LiveAnswerIntent(
      hostId: hostId, sessionId: need.sessionId, requestId: need.requestId, line: need.line, decision: decision)
  }

  var body: some View {
    // A line the Daemon cut to fit can't be checked against the request: answer it in the app.
    if need.kind == "approval" && !need.line.hasSuffix("…") {
      HStack(spacing: 8) {
        Button(intent: answer(.approve)) { pill("Approve", palette.panel, palette.textStrong) }
        Button(intent: answer(.always)) { pill("Always here", palette.textStrong, palette.raised) }
        Button(intent: answer(.deny)) { pill("Deny", palette.failedText, palette.raised).frame(width: 72) }
      }
      .buttonStyle(.plain)
    } else {
      // A question needs its choices, and a cut line its whole text: it opens the session.
      Link(destination: URL(string: sessionLink(hostId: hostId, sessionId: need.sessionId))!) {
        pill(LiveCopy.answerInApp, palette.panel, palette.textStrong)
      }
    }
  }
}

/// The lock screen: the takeover while anything needs you, else what's working over the horizon.
struct LiveLockScreen: View {
  let summary: LiveSummary
  let palette: ThemePalette

  var body: some View {
    if let (hostId, host, need) = summary.need {
      LiveTakeover(host: (hostId, host), need: need, needs: summary.needs, palette: palette)
        .padding(.horizontal, 16).padding(.vertical, 14)
    } else {
      VStack(spacing: 6) {
        LiveWorking(summary: summary, palette: palette).padding(.horizontal, 16).padding(.top, 14)
        LiveHorizon(palette: palette)
      }
    }
  }
}

/// The compact island: a celestial (or the amber mark) and "3 · 18m".
struct LiveCompactLeading: View {
  let summary: LiveSummary

  var body: some View {
    if summary.need != nil {
      LiveStar().fill(ThemePalette.midnight.needsYou.color).frame(width: 14, height: 14)
    } else {
      LiveCelestialView(celestial: summary.celestials.first).frame(width: 16, height: 16)
    }
  }
}

struct LiveCompactTrailing: View {
  let summary: LiveSummary

  var body: some View {
    let palette = ThemePalette.midnight
    if summary.need != nil {
      Text("\(summary.needs)").font(mono(13, weight: .medium)).foregroundStyle(palette.needsYouText.color)
    } else {
      HStack(spacing: 0) {
        Text("\(summary.working) · ")
        LiveElapsed(since: summary.since, compact: true)
      }
      .font(mono(13)).foregroundStyle(palette.textStrong.color)
      .frame(maxWidth: 76, alignment: .trailing)
    }
  }
}

/// The expanded island repeats the Live Activity on system black, in Midnight's text colours.
struct LiveIslandExpanded: View {
  let summary: LiveSummary

  var body: some View {
    if let (hostId, host, need) = summary.need {
      LiveTakeover(host: (hostId, host), need: need, needs: summary.needs, palette: .midnight)
    } else {
      LiveWorking(summary: summary, palette: .midnight, header: false)
    }
  }
}
