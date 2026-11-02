/**
 * The widgets' contract: the snapshot the app writes, decoded and merged by the extension's own
 * Swift (targets/widgets/Snapshot.swift). Needs swiftc, so it runs on a Mac.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
  synchronized,
  workspace,
} from "../src/home/fixtures.testing.ts";
import { buildHome } from "../src/home/model/home.ts";
import { routeOfLink } from "../src/widgets/links.ts";
import { widgetPublisher } from "../src/widgets/publish.ts";
import { widgetSnapshot } from "../src/widgets/snapshot.ts";

const swiftc = Bun.which("swiftc");

const directory = mkdtempSync(join(tmpdir(), "polaris-widgets-"));

const driver = join(directory, "driver");

beforeAll(() => {
  if (swiftc === null) return;

  const built = Bun.spawnSync([
    swiftc,
    "-O",
    "-o",
    driver,
    join(import.meta.dir, "../targets/widgets/Snapshot.swift"),
    join(import.meta.dir, "widgetsDriver/main.swift"),
  ]);

  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
}, 300_000);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

interface Drawn {
  readonly snapshot?: {
    readonly needsYou: number;
    readonly rows: ReadonlyArray<{
      readonly sessionId: string;
      readonly glyph: string;
      readonly link: string;
    }>;
  } | null;
  readonly inline: string | null;
  readonly trailing: ReadonlyArray<string>;
}

const draw = (json: string, pushes: ReadonlyArray<object> = []): Drawn =>
  // SAFETY: the driver prints JSON encoded from its `Drawn`, mirrored above.
  JSON.parse(
    Bun.spawnSync([driver, json, JSON.stringify(pushes), String(NOW)]).stdout.toString()
  ) as Drawn;

/** What the app writes: through the real publisher, at `writtenAt`. */
const written = (writtenAt: number) => {
  const home = buildHome(
    [
      {
        hostId: "studio",
        name: "Mac Studio",
        connection: "connected",
        followed: {
          seen: true,
          error: null,
          state: [
            snapshot({
              workspaces: [workspace("w1", "polaris")],
              sessions: [
                summary(
                  session({ id: "spike", title: "Spike GPUI review screen", state: "needs-you" }),
                  [commandApproval("spike", "r1", "cargo build", minutesAgo(42))]
                ),
                summary(session({ id: "planning", state: "working", turnCount: 24 })),
                summary(session({ id: "proto", state: "idle", updatedAt: minutesAgo(180) })),
              ],
            }),
            synchronized(),
          ].reduce(applyHostItem, emptyHostFeed),
        },
      },
    ],
    null
  );

  let json = "";

  widgetPublisher({ write: (value) => (json = value), reload: () => {} }, () => writtenAt).publish(
    widgetSnapshot(home, 1)
  );

  return json;
};

const push = (sessionId: string, at: number, kind = "needs-you") => ({
  kind,
  hostId: "studio",
  hostName: "Mac Studio",
  sessionId,
  requestId: "r9",
  subtitle: `Title of ${sessionId}`,
  at: new Date(at).toISOString(),
});

describe.skipIf(swiftc === null)("the widget extension reads the app's snapshot", () => {
  test("W1's line and W2's rows, ages and links as the app wrote them", () => {
    const drawn = draw(written(NOW));

    expect(drawn.inline).toBe("1 need you · 1 working");
    expect(drawn.snapshot?.rows.map((row) => [row.sessionId, row.glyph])).toEqual([
      ["spike", "needs-you"],
      ["planning", "working"],
      ["proto", "done"],
    ]);
    expect(drawn.trailing).toEqual(["42m", "turn 24", "3h"]);
  });

  test("a needs you push after the snapshot counts and lists until the app writes again", () => {
    const drawn = draw(written(NOW - 60_000), [
      push("proto", NOW - 1_000),
      push("spike", NOW - 1_000),
      push("old", NOW - 120_000),
      push("ended", NOW - 1_000, "turn-ended"),
    ]);

    expect(drawn.inline).toBe("2 need you · 1 working");
    expect(drawn.snapshot?.rows.map((row) => [row.sessionId, row.glyph])).toEqual([
      ["spike", "needs-you"],
      ["proto", "needs-you"],
      ["planning", "working"],
    ]);
    expect(routeOfLink(drawn.snapshot?.rows[1]?.link ?? "")).toEqual({
      screen: "thread",
      hostId: "studio",
      sessionId: "proto",
    });
  });

  test("Swift's links decode to the same route as the app's, odd ids included", () => {
    const drawn = draw(written(NOW - 60_000), [
      { ...push("a/b c#?", NOW), hostId: "mac/studio 1" },
    ]);

    expect(routeOfLink(drawn.snapshot?.rows[1]?.link ?? "")).toEqual({
      screen: "thread",
      hostId: "mac/studio 1",
      sessionId: "a/b c#?",
    });
  });

  test("a snapshot of an unknown version draws nothing", () => {
    const json = written(NOW);

    expect(json).toContain('"version":1');
    expect(draw(json.replace('"version":1', '"version":2')).snapshot ?? null).toBeNull();
  });
});
