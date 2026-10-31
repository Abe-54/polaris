import { describe, expect, test } from "bun:test";
import type { Profile, ProfileFunction } from "@polaris/protocol";
import {
  BIG_TRACE,
  FIXTURE_CHECKOUT,
  FIXTURE_DETAILS,
  FIXTURE_TURNS,
} from "../../preview/fixtures.ts";
import { buildProfile, LEDGER_PROFILE, TEST_PROFILE } from "../../preview/profiles.ts";
import { opensInEditor, originLabel, placeLabel, processLabel, shareLabel } from "./labels.ts";
import { overlap, rangeLabel } from "./overlap.ts";
import { profileReference } from "./reference.ts";
import { restartTarget } from "./restart.ts";

const ns = (iso: string, ms = 0) => BigInt(Date.parse(iso)) * 1_000_000n + BigInt(ms * 1_000_000);

describe("overlap", () => {
  test("names the part of the trace the Profile recorded, in both clocks", () => {
    // ledger-api's recording ends 700 ms into the overdue run.
    expect(overlap(LEDGER_PROFILE, ns(BIG_TRACE.startedAt), ns(BIG_TRACE.startedAt, 840))).toEqual({
      stretch: { from: 0, to: 700 },
      profile: { from: 11_700, to: 12_400 },
    });
    expect(overlap(TEST_PROFILE, ns(BIG_TRACE.startedAt), ns(BIG_TRACE.startedAt, 840))).toBeNull();
  });

  test.each([
    [{ from: 60, to: 700 }, "60–700 ms"],
    [{ from: 200, to: 3400 }, "0.2–3.4 s"],
  ])("rangeLabel %o", (range, label) => {
    expect(rangeLabel(range)).toBe(label);
  });
});

const recording = (change: Partial<Profile>): Profile => ({ ...LEDGER_PROFILE, ...change });

describe("how a Profile was made", () => {
  test.each([
    [{}, "Restarted with profiling by the agent"],
    [{ turn: null }, "Restarted with profiling by you"],
    [{ origin: "command" as const }, "Whole command"],
    [{ status: "recording" as const }, "Restarted with profiling by the agent · recording"],
    [{ status: "failed" as const }, "Recording failed"],
  ])("%o reads %s", (change, label) => {
    expect(originLabel(recording(change))).toBe(label);
  });

  test("a Daemon that doesn't say how falls back to the Turn and time", () => {
    const { origin: _, service: __, ...old } = LEDGER_PROFILE;
    const label = originLabel({ ...old, turn: FIXTURE_TURNS[11] });

    expect(label).toMatch(/^Recorded in turn 11 · \d\d:\d\d:\d\d$/);
    expect(processLabel(old)).toBe("bun run --cwd apps/api dev");
    expect(originLabel({ ...old, status: "recording" })).toBe("Recording…");
    expect(processLabel(LEDGER_PROFILE)).toBe("ledger-api · bun");
  });
});

const fn = (file: string | null, line: number | null): ProfileFunction => ({
  name: "f",
  file,
  line,
  selfMs: 0,
  totalMs: 0,
});

describe("where a function is", () => {
  const checkout = FIXTURE_CHECKOUT.checkout;

  test.each([
    [fn(`file://${checkout}/src/fx.ts`, 23), "fx.ts:23", true],
    [fn(null, null), "(native)", false],
    [fn("node:tls", 1716), "(node:tls)", false],
    [fn(`${checkout}/node_modules/undici/index.js`, 9), "index.js:9", false],
    [fn("/opt/elsewhere/tool.js", 3), "tool.js:3", false],
  ])("%o is %s", (f, label, opens) => {
    expect(placeLabel(f, checkout)).toBe(label);
    expect(opensInEditor(f, checkout)).toBe(opens);
  });

  test("a share of the recording rounds, and a sliver isn't 0%", () => {
    expect([shareLabel(7192, 12_400), shareLabel(10, 12_400), shareLabel(5, 0)]).toEqual([
      "58%",
      "<1%",
      "–",
    ]);
  });
});

describe("restartTarget", () => {
  test("is the root service's process from its spans' resource", () => {
    const detail = FIXTURE_DETAILS.find((d) => d.summary.id === BIG_TRACE.id) ?? null;
    const pid = detail?.spans.find((s) => s.service === "ledger-api")?.resource["process.pid"];

    expect(restartTarget(detail)).toEqual({ service: "ledger-api", pid: Number(pid) });
  });

  test("is nothing when no span carries a pid", () => {
    const detail = FIXTURE_DETAILS[0];

    if (detail === undefined) throw new Error("no fixture");
    const bare = { ...detail, spans: detail.spans.map((s) => ({ ...s, resource: {} })) };

    expect([restartTarget(bare), restartTarget(null)]).toEqual([null, null]);
  });
});

describe("profileReference", () => {
  const detail = buildProfile(TEST_PROFILE, [
    { fn: "fetchRate", at: 0, ms: 3000, calls: [{ fn: "JSON.parse", at: 100, ms: 900 }] },
  ]);

  test("names the recording, its process and its hottest functions by checkout path", () => {
    expect(profileReference(detail, null, FIXTURE_CHECKOUT.checkout)).toBe(
      "Profile `prof-test-overdue-12` in this checkout: `bun test overdue-totals` (bun, pid 47052, 3.1 s recorded, turn 12)\n" +
        "Hottest: `fetchRate` (src/fx.ts:23) 97%, `JSON.parse` (native) 29%"
    );
  });

  test("adds the selected frame", () => {
    expect(
      profileReference(detail, { functionIndex: 1, durationMs: 900 }, FIXTURE_CHECKOUT.checkout)
    ).toMatch(/\nFrame: `JSON.parse` \(native\), 900 ms$/);
  });
});
