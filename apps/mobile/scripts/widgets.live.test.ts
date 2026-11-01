/**
 * The Live Activity's contract: slices the app builds (src/live/content.ts), folded by the
 * extension's own Swift (targets/widgets/LiveSlices.swift). Needs swiftc and Apple's SDK, so it runs only on macOS.
 */
import { CELESTIAL_PLANETS, CELESTIAL_RARE } from "@polaris/protocol";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHostItem, emptyHostFeed } from "../src/home/feed/fold.ts";
import {
  commandApproval,
  minutesAgo,
  NOW,
  session,
  snapshot,
  summary,
} from "../src/home/fixtures.testing.ts";
import { type LiveHost, liveContent } from "../src/live/content.ts";
import { LIVE_CELESTIALS_PATH, liveCelestialsSwift, TONES } from "./liveCelestials.ts";

// Apple-only frameworks: Linux toolchains have swiftc but no SwiftUI, CryptoKit or os.
const swiftc = process.platform === "darwin" ? Bun.which("swiftc") : null;

const directory = mkdtempSync(join(tmpdir(), "polaris-live-"));

const driver = join(directory, "driver");

beforeAll(() => {
  if (swiftc === null) return;

  const built = Bun.spawnSync([
    swiftc,
    "-o",
    driver,
    join(import.meta.dir, "../targets/widgets/LiveSlices.swift"),
    join(import.meta.dir, "liveFoldDriver/main.swift"),
  ]);

  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
}, 300_000);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

interface Folded {
  readonly hosts: number;
  readonly working: number;
  readonly since: number | null;
  readonly step: {
    readonly host: string;
    readonly line: string;
    readonly harness: string | null;
  } | null;
  readonly need: { readonly host: string; readonly requestId: string } | null;
  readonly needs: number;
  readonly celestials: ReadonlyArray<string>;
  readonly unreadable: number;
}

const fold = (slices: ReadonlyArray<string>): Folded =>
  // SAFETY: the driver prints JSON in Folded's shape.
  JSON.parse(Bun.spawnSync([driver, ...slices]).stdout.toString()) as Folded;

const working = (id: string, minutes: number, celestial: string) =>
  session({ id, state: "working", updatedAt: minutesAgo(minutes), celestial });

const host = (
  hostAddress: string,
  name: string,
  sessions: ReturnType<typeof summary>[]
): LiveHost => ({
  hostId: hostAddress,
  hostAddress,
  name,
  feed: [snapshot({ sessions })].reduce(applyHostItem, emptyHostFeed),
});

test.skipIf(swiftc === null)("the extension folds the app's slices across Hosts", () => {
  const { slices } = liveContent([
    host("a", "Mac Studio", [
      summary(working("s1", 18, "giant")),
      summary(working("s2", 2, "storm")),
    ]),
    host("b", "lucas-rpi", [
      summary(working("s3", 5, "polar")),
      summary(working("s4", 1, "banded")),
      summary(session({ id: "s5", state: "needs-you" }), [
        commandApproval("s5", "r1", "git push", minutesAgo(3)),
      ]),
    ]),
  ]);

  expect(fold([...slices, "unopened"])).toEqual({
    hosts: 2,
    working: 4,
    since: Math.floor((NOW - 18 * 60_000) / 1000),
    step: null,
    need: { host: "lucas-rpi", requestId: "r1" },
    needs: 1,
    // Three at most, the first Host's first.
    celestials: ["claude/storm", "claude/giant", "claude/banded"],
    unreadable: 1,
  });
});

test("the extension's celestials match @polaris/ui's and the Harness hues", () => {
  expect(readFileSync(LIVE_CELESTIALS_PATH, "utf8")).toBe(liveCelestialsSwift());
});

/** The generated Swift table named `name`, as key → numbers. */
const table = (name: string): Map<string, number[]> => {
  const block = new RegExp(`let ${name}: \\[String: \\[\\w+\\]\\] = \\[\\n([^]*?)\\n\\]`).exec(
    liveCelestialsSwift()
  )?.[1];

  return new Map(
    [...(block ?? "").matchAll(/"([\w-]+)": \[([^\]]*)\]/g)].map(([, key, list]) => [
      key ?? "",
      (list ?? "").split(", ").map(Number),
    ])
  );
};

test("every body a session can get has its runs, in tones every palette has", () => {
  const bodies = table("liveBodies");
  const used = [...bodies.values()].flatMap((runs) => runs.filter((_, i) => i % 4 === 3));
  const palettes = [...table("liveHarnessTones").values(), ...table("liveBodyTones").values()];

  expect([...CELESTIAL_PLANETS, ...CELESTIAL_RARE].filter((body) => !bodies.has(body))).toEqual([]);
  expect(Math.max(...used)).toBe(TONES.length - 1);
  expect(palettes.every((tones) => tones.length === TONES.length)).toBe(true);
  expect(table("liveBodyTones").has("death-star")).toBe(true);
});
