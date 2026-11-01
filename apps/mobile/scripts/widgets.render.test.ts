/**
 * W2 in the app's theme: scripts/widgetsDriver/render.swift draws targets/widgets/HomeWidgetView
 * on macOS and samples its pixels. Needs swiftc and Apple's SDK, so it runs only on macOS.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PALETTES } from "../src/horizon/scene.ts";

// Apple-only frameworks: Linux toolchains have swiftc but no SwiftUI, CryptoKit or os.
const swiftc = process.platform === "darwin" ? Bun.which("swiftc") : null;

const directory = mkdtempSync(join(tmpdir(), "polaris-widget-render-"));

const driver = join(directory, "render");

const targets = join(import.meta.dir, "../targets/widgets");

beforeAll(() => {
  if (swiftc === null) return;

  const sources = ["Theme", "Snapshot", "Glyphs", "Horizon", "HomeWidgetView"].map((name) =>
    join(targets, `${name}.swift`)
  );

  const built = Bun.spawnSync([
    swiftc,
    "-parse-as-library",
    "-o",
    driver,
    ...sources,
    join(import.meta.dir, "widgetsDriver/render.swift"),
  ]);

  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
}, 300_000);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

test.skipIf(swiftc === null).each(["midnight", "moonlit"] as const)(
  "W2 draws its horizon in %s's ridge colour",
  (name) => {
    const run = Bun.spawnSync([driver, name, "-"]);
    // SAFETY: the driver prints JSON encoded from its `samples`, a [String: String].
    const samples = JSON.parse(run.stdout.toString()) as { readonly ridge: string };

    expect(samples.ridge).toBe(PALETTES[name].back.toLowerCase());
  }
);
