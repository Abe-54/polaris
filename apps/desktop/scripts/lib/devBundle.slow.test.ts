import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_APP_NAME, devBundleBinary } from "./devBundle.ts";
import { REPO_ROOT, stockElectronBinary } from "./electron.ts";

const plistValue = (file: string, key: string) =>
  spawnSync("plutil", ["-extract", key, "raw", file], { encoding: "utf8" }).stdout.trim();

describe.skipIf(process.platform !== "darwin")("Polaris Dev.app", () => {
  test("named, signed, reused while its stamp holds, rebuilt when the icon changes", () => {
    const outDir = mkdtempSync(join(tmpdir(), "polaris-dev-bundle-"));
    const icon = join(outDir, "icon.icns");

    copyFileSync(join(REPO_ROOT, "design/assets/app-icon/dusk/PolarisDev.icns"), icon);
    const input = { electron: stockElectronBinary(), outDir, icon };

    try {
      const binary = devBundleBinary(input);
      const app = join(outDir, `${DEV_APP_NAME}.app`);
      const info = join(app, "Contents/Info.plist");

      expect(binary).toBe(join(app, "Contents/MacOS/Polaris Dev"));
      expect(existsSync(binary)).toBe(true);
      expect(plistValue(info, "CFBundleName")).toBe("Polaris Dev");
      expect(plistValue(info, "CFBundleDisplayName")).toBe("Polaris Dev");
      expect(plistValue(info, "CFBundleIdentifier")).toBe("dev.lux.polaris.dev");
      expect(plistValue(info, "CFBundleExecutable")).toBe("Polaris Dev");
      expect(existsSync(join(app, "Contents/Frameworks/Polaris Dev Helper (Renderer).app"))).toBe(
        true
      );
      expect(spawnSync("codesign", ["--verify", "--deep", app]).status).toBe(0);

      const built = statSync(app).mtimeMs;

      expect(devBundleBinary(input)).toBe(binary);
      expect(statSync(app).mtimeMs).toBe(built);

      writeFileSync(icon, "a different icon");
      devBundleBinary(input);
      expect(statSync(app).mtimeMs).not.toBe(built);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
