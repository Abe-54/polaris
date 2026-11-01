/**
 * The extensions' theme: `targets/widgets/Theme.swift` holds @polaris/ui's tokens and the
 * horizon's ridges for both themes, and reads the name the app writes. The Swift run needs swiftc and SwiftUI, so macOS.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { midnight, moonlit } from "@polaris/ui/tokens";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PALETTES } from "../src/horizon/scene.ts";
import { THEME_KEY, themePublisher } from "../src/widgets/theme.ts";

const THEME_SWIFT = join(import.meta.dir, "../targets/widgets/Theme.swift");

const source = readFileSync(THEME_SWIFT, "utf8");

/** Each `name: ThemeColour(0xRRGGBB[, alpha: 0xAA])` in a palette, as lowercase #rrggbb[aa]. */
const swiftPalette = (name: "midnight" | "moonlit"): Record<string, string> => {
  const start = source.indexOf(`static let ${name} = ThemePalette(`);
  const block = start === -1 ? undefined : source.slice(start, source.indexOf("\n  )", start));

  if (block === undefined) throw new Error(`no ${name} palette in Theme.swift`);

  const entries = [
    ...block.matchAll(/(\w+): ThemeColour\(0x([0-9A-F]{6})(?:, alpha: 0x([0-9A-F]{2}))?\)/g),
  ].map(([, key, hex, alpha]): [string, string] => [
    key ?? "",
    `#${hex ?? ""}${alpha ?? ""}`.toLowerCase(),
  ]);

  return Object.fromEntries(entries);
};

describe("Theme.swift", () => {
  test.each([
    ["midnight", midnight],
    ["moonlit", moonlit],
  ] as const)("%s holds @polaris/ui's tokens and the horizon's ridges", (name, tokens) => {
    const palette = swiftPalette(name);
    const { ridgeBack, ridgeFront, ...colours } = palette;

    expect(Object.keys(colours).length).toBeGreaterThan(10);

    const expected: Record<string, string> = tokens;

    for (const [key, value] of Object.entries(colours))
      expect([key, value]).toEqual([key, expected[key]?.toLowerCase() ?? "missing"]);

    expect([ridgeBack, ridgeFront]).toEqual([
      PALETTES[name].back.toLowerCase(),
      PALETTES[name].front.toLowerCase(),
    ]);
  });

  // Apple-only frameworks: Linux toolchains have swiftc but no SwiftUI, CryptoKit or os.
  const swiftc = process.platform === "darwin" ? Bun.which("swiftc") : null;
  const directory = mkdtempSync(join(tmpdir(), "polaris-theme-"));

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  test.skipIf(swiftc === null)(
    "the extensions read the theme the app writes, and Midnight until it has",
    () => {
      const driver = join(directory, "main.swift");
      const suite = `dev.lux.polaris.test.${process.pid}`;

      writeFileSync(
        driver,
        [
          "import Foundation",
          `let defaults = UserDefaults(suiteName: "${suite}")!`,
          `defaults.removePersistentDomain(forName: "${suite}")`,
          "var read = [PolarisTheme.current(defaults).rawValue]",
          `for value in CommandLine.arguments.dropFirst() { defaults.set(value, forKey: "${THEME_KEY}"); read.append(PolarisTheme.current(defaults).rawValue) }`,
          "read.append(PolarisTheme.current(nil).rawValue)",
          `defaults.removePersistentDomain(forName: "${suite}")`,
          'print(read.joined(separator: " "))',
        ].join("\n")
      );

      const binary = join(directory, "theme");
      const built = Bun.spawnSync([swiftc ?? "swiftc", "-o", binary, THEME_SWIFT, driver]);

      if (built.exitCode !== 0) throw new Error(built.stderr.toString());

      const run = Bun.spawnSync([binary, "moonlit", "midnight", "sepia"]);

      expect(run.stdout.toString().trim()).toBe("midnight moonlit midnight midnight midnight");
    },
    300_000
  );
});

describe("the theme publisher", () => {
  test("writes each change of theme and redraws, but spends nothing on a repeat", () => {
    const written: string[] = [];
    let reloads = 0;

    const publish = themePublisher({
      write: (theme) => written.push(theme),
      reload: () => (reloads += 1),
    });

    publish("midnight");
    publish("midnight");
    publish("moonlit");
    publish("midnight");

    expect(written).toEqual(["midnight", "moonlit", "midnight"]);
    expect(reloads).toBe(3);
  });
});
