/**
 * macOS: "Polaris Computer Use.app", the helper app that holds computer use's privacy grants
 * (ADR 0104). It sits beside `PolarisDaemon.app`, ships flat like it (`../bundle.ts`), and
 * holds the pinned agent-desktop and the preview's capture tool (`capture/`) next to its
 * launcher (`launcher.c`).
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundleOf, DAEMON_ICON } from "../bundle.ts";

/** The folder's name is what System Settings and permission prompts show. */
export const COMPUTER_USE_BUNDLE = "Polaris Computer Use.app";

/** Stable across versions: a Developer ID build keeps its grants through upgrades. */
export const COMPUTER_USE_BUNDLE_ID = "dev.lux.polaris.computer-use";

/** Dev builds are signed ad hoc and must never share the release build's TCC row. */
export const COMPUTER_USE_DEV_BUNDLE_ID = `${COMPUTER_USE_BUNDLE_ID}.dev`;

export const computerUseBundleId = (release: boolean): string =>
  release ? COMPUTER_USE_BUNDLE_ID : COMPUTER_USE_DEV_BUNDLE_ID;

/** The bundle's main executable, built from `launcher.c`. */
export const COMPUTER_USE_LAUNCHER = "polaris-computer-use";

/** The live preview's ScreenCaptureKit tool, built from `capture/` (ENG-846). */
export const COMPUTER_USE_CAPTURE = "polaris-capture";

/** Each file of the helper by its flat name in a build, and its path inside the bundle. */
export const HELPER_FILES = {
  [COMPUTER_USE_LAUNCHER]: `Contents/MacOS/${COMPUTER_USE_LAUNCHER}`,
  "agent-desktop": "Contents/MacOS/agent-desktop",
  "agent-desktop-macos-helper": "Contents/MacOS/agent-desktop-macos-helper",
  [COMPUTER_USE_CAPTURE]: `Contents/MacOS/${COMPUTER_USE_CAPTURE}`,
  "computer-use-Info.plist": "Contents/Info.plist",
  "computer-use-Polaris.icns": `Contents/Resources/${DAEMON_ICON}`,
  "computer-use-CodeResources": "Contents/_CodeSignature/CodeResources",
} as const satisfies Record<string, string>;

export type HelperFile = keyof typeof HELPER_FILES;

// SAFETY: HELPER_FILES is a literal with no other keys, so its keys are exactly HelperFile.
export const HELPER_FILE_NAMES = Object.keys(HELPER_FILES) as ReadonlyArray<HelperFile>;

/** The helper's executables: the launcher and the tools it may run. */
export const HELPER_EXECUTABLES: ReadonlySet<HelperFile> = new Set([
  COMPUTER_USE_LAUNCHER,
  "agent-desktop",
  "agent-desktop-macos-helper",
  COMPUTER_USE_CAPTURE,
]);

/** A tool the launcher runs from the bundle's `Contents/MacOS`. */
export type HelperTool = "agent-desktop" | typeof COMPUTER_USE_CAPTURE;

/** `0.8.0` from `0.8.0-dev.12.abc1234`: bundle version keys take numbers only. */
const bundleVersion = (version: string): string => version.split(/[-+]/)[0] ?? version;

const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The helper's Info.plist. It names no dev build: an ad hoc grant is keyed to the bundle's
 * cdhash, so a dev helper must stay byte for byte the same from one dev build to the next.
 */
export const helperInfoPlist = (version: string, release: boolean): string => {
  const short = escapeXml(bundleVersion(version));

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${computerUseBundleId(release)}</string>
  <key>CFBundleName</key>
  <string>Polaris Computer Use</string>
  <key>CFBundleDisplayName</key>
  <string>Polaris Computer Use</string>
  <key>CFBundleExecutable</key>
  <string>${COMPUTER_USE_LAUNCHER}</string>
  <key>CFBundleIconFile</key>
  <string>${DAEMON_ICON.replace(/\.icns$/, "")}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleShortVersionString</key>
  <string>${short}</string>
  <key>CFBundleVersion</key>
  <string>${short}</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>Polaris uses this to operate apps for your agent sessions.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>Polaris uses this to show you the window your agent session is working in.</string>
</dict>
</plist>
`;
};

/**
 * Where each helper file of the build at `source` (the Daemon's executable) is: in the helper
 * beside the Daemon's bundle, else flat beside `source` (an upload). Null when the build has
 * no helper, as builds before ENG-846 don't.
 */
export const helperSources = (source: string): Record<HelperFile, string> | null => {
  const real = existsSync(source) ? realpathSync(source) : source;
  const daemon = bundleOf(real);

  const at = (name: HelperFile) =>
    daemon === null
      ? join(dirname(real), name)
      : join(dirname(daemon), COMPUTER_USE_BUNDLE, HELPER_FILES[name]);

  const sources = Object.fromEntries(HELPER_FILE_NAMES.map((name) => [name, at(name)]));

  // SAFETY: built from HELPER_FILE_NAMES, so it has exactly the HelperFile keys.
  const typed = sources as Record<HelperFile, string>;

  return existsSync(typed[COMPUTER_USE_LAUNCHER]) && existsSync(typed["computer-use-CodeResources"])
    ? typed
    : null;
};

/** The helper installed beside the Daemon's bundle at `daemonExecutable`; null when there is none. */
export const helperBeside = (daemonExecutable: string): string | null => {
  const real = existsSync(daemonExecutable) ? realpathSync(daemonExecutable) : daemonExecutable;
  const daemon = bundleOf(real);

  if (daemon === null) return null;
  const helper = join(dirname(daemon), COMPUTER_USE_BUNDLE);

  return existsSync(join(helper, HELPER_FILES[COMPUTER_USE_LAUNCHER])) ? helper : null;
};

/** The launcher inside the helper bundle at `helper`. */
export const launcherOf = (helper: string): string =>
  join(helper, HELPER_FILES[COMPUTER_USE_LAUNCHER]);
