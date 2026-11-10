import { expect, test } from "bun:test";
import {
  type HostSlice,
  liveActivityBody,
  MAX_LIVE_HOSTS,
  MAX_LIVE_SLICE_CHARS,
  toBase64Url,
} from "@polaris/protocol/relay";
import { sealSlice } from "./live.ts";
import { openSlice } from "./push.testing.ts";
import { pushSuite } from "./seal.ts";

const keys = await pushSuite.kem.generateKeyPair();

const pushKey = toBase64Url(new Uint8Array(await pushSuite.kem.serializePublicKey(keys.publicKey)));

const open = (sealed: string) => openSlice(keys.privateKey, sealed);

const CELESTIALS = ["claude/tilted-ring", "codex/twin-ring", "opencode/star-spark"];

const atLimits = (char: string): HostSlice => ({
  v: 1,
  hostId: "host-1",
  host: char.repeat(64 / char.length),
  seq: 41,
  working: 3,
  since: 1_793_000_000,
  step: {
    at: 1_793_000_100,
    sessionId: "s1",
    session: char.repeat(200 / char.length),
    line: char.repeat(400 / char.length),
    harness: char.repeat(40 / char.length),
  },
  need: {
    at: 1_793_000_050,
    sessionId: "s2",
    session: char.repeat(200 / char.length),
    line: char.repeat(400 / char.length),
    harness: char.repeat(40 / char.length),
    requestId: "r1",
    kind: "approval",
  },
  needs: 2,
  celestials: CELESTIALS,
});

test.each([
  ["ASCII", "a"],
  ["CJK", "需"],
  ["emoji", "🦀"],
])("a %s slice at its limits seals within its share and keeps what answers", async (_, char) => {
  const sealed = await sealSlice(pushKey, atLimits(char));

  expect(sealed.length).toBeLessThanOrEqual(MAX_LIVE_SLICE_CHARS);

  const opened = await open(sealed);

  expect(opened.need?.requestId).toBe("r1");
  expect(opened.need?.sessionId).toBe("s2");
  expect(opened.since).toBe(1_793_000_000);
  expect(atLimits(char).need?.line.startsWith(opened.need?.line.replace(/…$/, "") ?? "x")).toBe(
    true
  );
  // Under the takeover the step and celestials aren't drawn, so they give way first.
  expect([opened.step, opened.celestials]).toEqual([null, undefined]);
});

test("a short slice is sealed unchanged, its three celestials and Harness names included", async () => {
  const short = atLimits("a");

  const slice: HostSlice = {
    ...short,
    host: "studio",
    step: short.step && {
      ...short.step,
      session: "Fix the relay",
      line: "bun test",
      harness: "Claude Code",
    },
    need: null,
    needs: 0,
  };

  expect(await open(await sealSlice(pushKey, slice))).toEqual(slice);
});

test("the lines give way to the celestials, and the celestials to the Host's name", async () => {
  const working = (char: string): HostSlice => ({ ...atLimits(char), need: null, needs: 0 });
  const ascii = await open(await sealSlice(pushKey, working("a")));

  expect([ascii.celestials, ascii.host]).toEqual([CELESTIALS, working("a").host]);
  expect(ascii.step?.line.endsWith("…")).toBe(true);

  const crabs = await open(await sealSlice(pushKey, { ...working("🦀"), hostId: "h".repeat(200) }));

  expect(crabs.celestials).toBeUndefined();
  expect(crabs.host).not.toBe(working("🦀").host);
});

test("every Host the activity carries fits one liveactivity push, takeover alert included", async () => {
  const slices = await Promise.all(
    Array.from({ length: MAX_LIVE_HOSTS }, () => sealSlice(pushKey, atLimits("🦀")))
  );

  const body = liveActivityBody({
    event: "update",
    timestamp: 1_793_000_200,
    state: { v: 1, slices },
    alert: true,
  });

  // APNs refuses a liveactivity payload over 4 KB.
  expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(4096);
});
