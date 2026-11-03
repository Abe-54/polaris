/**
 * The Mobile App's type scale, from Paper's H4 (Mobile page): SF Pro and SF Mono through the
 * system families, sizes and line heights in points, Regular and Medium only (DESIGN.md).
 * Shaped as React Native text styles; letter spacing is left to the system everywhere.
 */
export const mobileFont = {
  sans: "system-ui",
  mono: "ui-monospace",
} as const;

export const mobileWeight = {
  regular: "400",
  medium: "500",
} as const;

interface MobileTextStyle {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: (typeof mobileWeight)[keyof typeof mobileWeight];
}

/** Native family names on Android; iOS and web keep their system design aliases. */
export const resolveMobileFonts = (platform: string) =>
  platform === "android" ? ({ sans: "sans-serif", mono: "monospace" } as const) : mobileFont;

/** Build the same type scale for a platform's font families. */
export const createMobileType = (font: { readonly sans: string; readonly mono: string }) => {
  const sans = (fontSize: number, lineHeight: number, fontWeight: "400" | "500") =>
    ({ fontFamily: font.sans, fontSize, lineHeight, fontWeight }) satisfies MobileTextStyle;

  const mono = (fontSize: number, lineHeight: number) =>
    ({
      fontFamily: font.mono,
      fontSize,
      lineHeight,
      fontWeight: mobileWeight.regular,
    }) satisfies MobileTextStyle;

  return {
    /** View titles ("Sessions", "Hosts"), at the system's own tracking (DESIGN.md: UI never tightens). */
    largeTitle: sans(34, 40, mobileWeight.medium),
    /** Row titles in needs you. */
    title: sans(17, 22, mobileWeight.medium),
    /** Messages and the composer. */
    body: sans(17, 22, mobileWeight.regular),
    /** Row titles in working and recent. */
    heading: sans(16, 21, mobileWeight.medium),
    /** Questions and summaries under a title. */
    callout: sans(15, 21, mobileWeight.regular),
    /** Buttons (Approve, Deny). */
    label: sans(15, 18, mobileWeight.medium),
    /** Chips, the hosts pill, approval prompts. */
    subhead: sans(14, 18, mobileWeight.regular),
    /** Second lines and ages. */
    footnote: sans(13, 18, mobileWeight.regular),
    /** Section headers (needs you, working, recent). */
    section: sans(13, 16, mobileWeight.medium),
    /** Tab bar labels. */
    tab: sans(11, 14, mobileWeight.medium),
    /** Commands ("$ cargo build --release"), paths and branch names. */
    command: mono(14, 20),
    /** The mono index on needs you rows (01, 02). */
    index: mono(12, 16),
  } as const satisfies Record<string, MobileTextStyle>;
};

export const mobileType = createMobileType(mobileFont);

export type MobileTextRole = keyof typeof mobileType;
