import { afterAll, expect, test } from "bun:test";
import { readSetting, writeSetting } from "./settings.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

const root = newTempDir("pl-rset-", { short: true });

afterAll(() => removeTempDir(root));

// RX1-10: a route saved with ws:// to another machine is never dialled again.
test.each([
  ["ws://relay.example/v1", false],
  ["ws://127.0.0.1:7600/v1", true],
  ["wss://relay.example/v1", true],
])("a saved route to %s stays on: %p", (url, on) => {
  writeSetting(root, { enabled: true, url });

  expect(readSetting(root)).toEqual({ enabled: on, url });
});
