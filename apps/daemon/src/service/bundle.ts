/**
 * The macOS Daemon as a background app bundle (ENG-680): System Settings names a process
 * and draws its icon from its enclosing bundle, so a bare `polaris` shows as an exec icon.
 * A build ships the bundle's files flat (Release archives and uploads hold plain files);
 * `polaris install` and `polaris upgrade` put them back at their places in the bundle.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The bundle's directory name, beside the version's `polaris` link. */
export const DAEMON_BUNDLE = "PolarisDaemon.app";

/** Stable across versions, so a signed Daemon keeps its privacy grants through upgrades. */
export const DAEMON_BUNDLE_ID = "dev.lux.polaris.daemon";

/** The Desktop App's bundle id: Login Items lists the LaunchAgent under it. */
export const DESKTOP_BUNDLE_ID = "dev.lux.polaris";

export const DAEMON_ICON = "Polaris.icns";

/** Each file of the bundle by its flat name in a build, and its path inside the bundle. */
export const BUNDLE_FILES = {
  polaris: "Contents/MacOS/polaris",
  betterleaks: "Contents/MacOS/betterleaks",
  "Info.plist": "Contents/Info.plist",
  [DAEMON_ICON]: "Contents/Resources/Polaris.icns",
  CodeResources: "Contents/_CodeSignature/CodeResources",
} as const satisfies Record<string, string>;

export type BundleFile = keyof typeof BUNDLE_FILES;

// SAFETY: BUNDLE_FILES is a literal with no other keys, so its keys are exactly BundleFile.
export const BUNDLE_FILE_NAMES = Object.keys(BUNDLE_FILES) as ReadonlyArray<BundleFile>;

/** `0.8.0` from `0.8.0-dev.12.abc1234`: bundle version keys take numbers only. */
const bundleVersion = (version: string): string => version.split(/[-+]/)[0] ?? version;

const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The bundle's Info.plist: a background-only app named Polaris, with the Polaris icon. */
export const infoPlist = (version: string): string => {
  const short = escapeXml(bundleVersion(version));

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${DAEMON_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>Polaris</string>
  <key>CFBundleDisplayName</key>
  <string>Polaris</string>
  <key>CFBundleExecutable</key>
  <string>polaris</string>
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
  <key>PolarisVersion</key>
  <string>${escapeXml(version)}</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
</dict>
</plist>
`;
};

/** The bundle root when `executable` is its `Contents/MacOS/polaris`; null otherwise. */
export const bundleOf = (executable: string): string | null => {
  const macos = dirname(executable);
  const contents = dirname(macos);
  const root = dirname(contents);

  return basename(macos) === "MacOS" && basename(contents) === "Contents" && root.endsWith(".app")
    ? root
    : null;
};

/**
 * Where each bundle file of the build at `source` is: inside its bundle when `source` is (or
 * links to) one's executable, else flat beside it (an upload). Null when it isn't a bundle.
 */
export const bundleSources = (source: string): Record<BundleFile, string> | null => {
  const real = existsSync(source) ? realpathSync(source) : source;
  const root = bundleOf(real);

  const at = (name: BundleFile) =>
    root === null ? join(dirname(real), name) : join(root, BUNDLE_FILES[name]);

  const sources = Object.fromEntries(BUNDLE_FILE_NAMES.map((name) => [name, at(name)]));

  // SAFETY: built from BUNDLE_FILE_NAMES, so it has exactly the BundleFile keys.
  const typed = sources as Record<BundleFile, string>;

  return existsSync(typed["Info.plist"]) && existsSync(typed.CodeResources) ? typed : null;
};
