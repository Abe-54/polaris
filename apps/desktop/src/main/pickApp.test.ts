import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppId } from "@polaris/protocol";
import { readBundle } from "./pickApp.ts";

const root = mkdtempSync("/tmp/pl-pick-");

afterAll(() => rmSync(root, { recursive: true, force: true }));

const bundle = (name: string, plist: string | null) => {
  const path = join(root, `${name}.app`);

  mkdirSync(join(path, "Contents"), { recursive: true });

  if (plist !== null) writeFileSync(join(path, "Contents", "Info.plist"), plist);

  return path;
};

const xml = (entries: Record<string, string>) =>
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${Object.entries(entries)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join("")}</dict></plist>`;

describe.skipIf(process.platform !== "darwin")("readBundle", () => {
  test("reads the bundle id and prefers the display name", async () => {
    const path = bundle(
      "Ghost",
      xml({
        CFBundleIdentifier: "com.mitchellh.ghostty",
        CFBundleName: "ghostty",
        CFBundleDisplayName: "Ghostty",
      })
    );

    expect(await readBundle(path)).toEqual({
      id: AppId.make("com.mitchellh.ghostty"),
      name: "Ghostty",
    });
  });

  test("falls back to the folder's name, and answers null without a bundle id or plist", async () => {
    expect(
      await readBundle(bundle("Trips", xml({ CFBundleIdentifier: "dev.example.trips" })))
    ).toEqual({
      id: AppId.make("dev.example.trips"),
      name: "Trips",
    });
    expect(await readBundle(bundle("Nameless", xml({ CFBundleName: "Nameless" })))).toBeNull();
    expect(await readBundle(bundle("Empty", null))).toBeNull();
  });

  test("reads a binary plist, as Apple's own apps ship", async () => {
    expect(await readBundle("/System/Applications/Calculator.app")).toEqual({
      id: AppId.make("com.apple.calculator"),
      name: "Calculator",
    });
  });
});
