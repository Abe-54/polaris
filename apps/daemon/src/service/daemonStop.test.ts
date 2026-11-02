import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { takeStopRecord, writeStopRecord } from "./daemonStop.ts";

const dirs: Array<string> = [];

const home = () => {
  const dir = newTempDir("polaris-stop-");
  dirs.push(dir);

  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

test("the next Daemon reads why the last one stopped, and a restart after it doesn't repeat it", () => {
  const root = home();
  writeStopRecord(root, "upgrade", "0.2.0");

  expect(takeStopRecord(root)).toMatchObject({ reason: "upgrade", fromVersion: "0.2.0" });
  expect(takeStopRecord(root)).toBeNull();
});

test("a damaged record is dropped rather than failing the Daemon's start", () => {
  const root = home();
  writeFileSync(join(root, "daemon-stop.json"), "{");

  expect(takeStopRecord(root)).toBeNull();
  expect(takeStopRecord(root)).toBeNull();
});
