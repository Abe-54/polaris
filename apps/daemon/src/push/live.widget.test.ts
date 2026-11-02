/**
 * The Daemon's sealed slices as the Mobile App's widget extension opens them: sealSlice here,
 * CryptoKit and the extension's own Swift there (apps/mobile/targets/widgets/LiveSlices.swift).
 * Needs swiftc, so it runs on a Mac.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { type HostSlice, toBase64Url } from "@polaris/protocol/relay";
import { Schema } from "effect";
import { sealSlice } from "./live.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

// CryptoKit is an Apple framework; a Linux Swift toolchain cannot build this driver.
const swiftc = process.platform === "darwin" ? Bun.which("swiftc") : null;

const mobile = join(import.meta.dir, "../../../mobile");

const directory = newTempDir("polaris-live-open-");

const driver = join(directory, "driver");

const generate = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);

  const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);

  return {
    privateKey: d ?? "",
    pushKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
  };
};

beforeAll(() => {
  if (swiftc === null) return;

  const built = Bun.spawnSync([
    swiftc,
    "-o",
    driver,
    join(mobile, "targets/widgets/LiveSlices.swift"),
    join(mobile, "scripts/liveOpenDriver/main.swift"),
  ]);

  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
}, 300_000);

afterAll(() => removeTempDir(directory));

/** What the driver prints per slice: the fields the activity draws, or where opening stopped. */
const Opened = Schema.Array(
  Schema.Union([
    Schema.Struct({ failure: Schema.String }),
    Schema.Struct({
      host: Schema.String,
      working: Schema.Number,
      step: Schema.NullOr(Schema.String),
      need: Schema.NullOr(Schema.String),
      celestials: Schema.Array(Schema.String),
    }),
  ])
);

const openAll = (privateKey: string, sealed: ReadonlyArray<string>) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Opened))(
    Bun.spawnSync([driver, privateKey, ...sealed]).stdout.toString()
  );

const working: HostSlice = {
  v: 1,
  hostId: "host-1",
  host: "Mac",
  seq: 4,
  working: 2,
  since: 1_793_340_000,
  step: { at: 1_793_340_100, sessionId: "s1", session: "Docs", line: "bun test", harness: "Codex" },
  need: null,
  needs: 0,
  celestials: ["codex/twin-ring", "claude/tilted-ring"],
};

// An older Host: no Harness names, no celestials.
const waiting: HostSlice = {
  v: 1,
  hostId: "host-2",
  host: "Pi",
  seq: 9,
  working: 0,
  since: null,
  step: null,
  need: {
    at: 1_793_340_200,
    sessionId: "s2",
    session: "Ship",
    line: "git push",
    requestId: "r1",
    kind: "approval",
  },
  needs: 1,
};

test.skipIf(swiftc === null)("the widget extension opens the Daemon's sealed slices", async () => {
  const device = await generate();
  const sealed = await Promise.all([working, waiting].map((s) => sealSlice(device.pushKey, s)));

  expect(openAll(device.privateKey, sealed)).toEqual([
    {
      host: "Mac",
      working: 2,
      step: "Codex Docs: bun test",
      need: null,
      celestials: ["codex/twin-ring", "claude/tilted-ring"],
    },
    { host: "Pi", working: 0, step: null, need: "approval r1: git push", celestials: [] },
  ]);
});

test.skipIf(swiftc === null)("a slice sealed to another key doesn't open", async () => {
  const [device, other] = await Promise.all([generate(), generate()]);

  expect(openAll(device.privateKey, [await sealSlice(other.pushKey, working)])).toEqual([
    { failure: "open" },
  ]);
});
