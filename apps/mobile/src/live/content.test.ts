import { describe, expect, test } from "bun:test";
import {
  ApprovalRequest,
  type HostStreamItem,
  SessionId,
  TurnId,
  TurnItem,
} from "@polaris/protocol";
import { decodeHostSlice, type HostSlice, MAX_LIVE_PLAINTEXT_BYTES } from "@polaris/protocol/relay";
import { Option, Schema } from "effect";
import { applyHostItem, emptyHostFeed } from "../home/feed/fold.ts";
import {
  commandApproval,
  DomainEvent,
  event,
  minutesAgo,
  NOW,
  question,
  secretRequest,
  session,
  type SessionInput,
  snapshot,
  summary,
} from "../home/fixtures.testing.ts";
import { IDLE_END_MS, type LiveHost, liveAction, liveContent } from "./content.ts";

const command = (sessionId: string, text: string, sequence = 2) =>
  event(
    sequence,
    DomainEvent.cases.TurnItemCompleted.make({
      sessionId: SessionId.make(sessionId),
      turnId: TurnId.make("t1"),
      item: TurnItem.cases.CommandExecution.make({
        id: text,
        startedAt: null,
        command: text,
        cwd: "/repo",
        output: "",
        exitCode: 0,
        status: "completed",
      }),
      subagentId: null,
    }),
    minutesAgo(1)
  );

const host = (
  hostAddress: string,
  items: ReadonlyArray<HostStreamItem>,
  name = hostAddress
): LiveHost => ({
  hostId: `id-${hostAddress}`,
  hostAddress,
  name,
  feed: items.reduce(applyHostItem, emptyHostFeed),
});

const opened = (json: string): HostSlice => Option.getOrThrow(decodeHostSlice(json));

const slicesOf = (hosts: ReadonlyArray<LiveHost>) => liveContent(hosts).slices.map(opened);

const working = (id: string, minutes: number, extra: Partial<SessionInput> = {}) =>
  session({ id, state: "working", updatedAt: minutesAgo(minutes), title: `Title ${id}`, ...extra });

describe("a Host's slice", () => {
  test("counts the user's working sessions from the longest-running; a Reviewer's don't count", () => {
    const [slice] = slicesOf([
      host("a", [
        snapshot({
          sessions: [
            summary(working("s1", 18)),
            summary(working("s2", 3)),
            summary(working("r1", 40, { origin: "reviewer" })),
            summary(session({ id: "s3", state: "idle" })),
          ],
        }),
      ]),
    ]);

    expect(slice?.working).toBe(2);
    expect(slice?.since).toBe(Math.floor((NOW - 18 * 60_000) / 1000));
  });

  test("names the newest step's session and Harness, and its line in the tool's words", () => {
    const [slice] = slicesOf([
      host("a", [snapshot({ sessions: [summary(working("s1", 5))] }), command("s1", "bun test")]),
    ]);

    expect(slice?.step).toMatchObject({
      sessionId: "s1",
      session: "Title s1",
      line: "bun test",
      harness: "Claude Code",
    });
  });

  test("the oldest open request is the takeover's, and every open one counts", () => {
    const [slice] = slicesOf([
      host("a", [
        snapshot({
          sessions: [
            summary(session({ id: "s1", state: "needs-you" }), [
              commandApproval("s1", "newer", "git push", minutesAgo(1)),
            ]),
            summary(session({ id: "s2", state: "needs-you", title: "Release" }), [
              question("s2", "older", "Which branch?", ["main"], minutesAgo(9)),
            ]),
          ],
        }),
      ]),
    ]);

    expect(slice?.needs).toBe(2);
    expect(slice?.need).toMatchObject({
      requestId: "older",
      session: "Release",
      line: "Which branch?",
      kind: "question",
    });
  });

  test("a secret takes over as a question, which opens the app: never Approve and Deny", () => {
    const [slice] = slicesOf([
      host("a", [
        snapshot({
          sessions: [
            summary(session({ id: "s1", state: "needs-you" }), [
              secretRequest("s1", "key", "Tailscale auth key", "To join the tailnet"),
            ]),
          ],
        }),
      ]),
    ]);

    expect(slice?.need).toMatchObject({ line: "Tailscale auth key", kind: "question" });
  });

  test("carries the three newest working sessions' celestials in their Harness", () => {
    const [slice] = slicesOf([
      host("a", [
        snapshot({
          sessions: [
            summary(working("s1", 30, { celestial: "giant" })),
            summary(working("s2", 20, { celestial: "storm", harness: "codex" })),
            summary(working("s3", 10, { celestial: "polar" })),
            summary(working("s4", 1)),
          ],
        }),
      ]),
    ]);

    expect(slice?.celestials).toEqual(["claude/ringed", "claude/polar", "codex/storm"]);
  });

  test("a step longer than a slice holds is cut to fit, keeping the Host's name", () => {
    const [slice] = liveContent([
      host(
        "a",
        [snapshot({ sessions: [summary(working("s1", 1))] }), command("s1", "x".repeat(2000))],
        "Mac Studio"
      ),
    ]).slices;

    expect(new TextEncoder().encode(slice).byteLength).toBeLessThanOrEqual(
      MAX_LIVE_PLAINTEXT_BYTES
    );
    expect(opened(slice ?? "").host).toBe("Mac Studio");
  });

  test("unfitted, as Android's local notification takes it, a long step stays whole", () => {
    const line = "x".repeat(2000);

    const [slice] = liveContent(
      [host("a", [snapshot({ sessions: [summary(working("s1", 1))] }), command("s1", line)])],
      false
    ).slices;

    expect(opened(slice ?? "").step?.line).toContain(line);
  });
});

describe("every Host", () => {
  const idle = (address: string) =>
    host(address, [snapshot({ sessions: [summary(session({ id: "s" }))] })]);

  const busy = (address: string) =>
    host(address, [snapshot({ sessions: [summary(working("s", 1))] })]);

  test("is ordered by relay address, as the Relay orders the slices", () => {
    expect(slicesOf([idle("c"), busy("a"), idle("b")]).map((s) => s.hostId)).toEqual([
      "id-a",
      "id-b",
      "id-c",
    ]);
  });

  test("past six Hosts, the ones with work stay", () => {
    const hosts = ["a", "b", "c", "d", "e", "f"].map(idle).concat(busy("z"));

    const shown = slicesOf(hosts).map((s) => s.hostId);

    expect(shown).toHaveLength(6);
    expect(shown).toContain("id-z");
  });

  test("is busy while anything works or waits on the user, and not when all are idle", () => {
    expect(liveContent([idle("a"), idle("b")]).busy).toBe(false);
    expect(liveContent([idle("a"), busy("b")]).busy).toBe(true);
  });
});

test.each([
  // running, busy, idle for (ms), action
  [false, true, null, "show"],
  [true, true, null, "show"],
  [false, false, IDLE_END_MS, "none"],
  [true, false, IDLE_END_MS - 1, "update"],
  [true, false, IDLE_END_MS, "end"],
] as const)("running %p, busy %p, idle for %p: %p", (running, busy, idleFor, action) => {
  expect(liveAction(running, busy, idleFor === null ? null : NOW - idleFor, NOW)).toBe(action);
});

test("P9-10: attach takeover opens the app without remembered approval actions", () => {
  const request = Schema.decodeUnknownSync(ApprovalRequest)({
    ...Schema.encodeSync(ApprovalRequest)(
      commandApproval("s1", "attach", "Profile Node", minutesAgo(1))
    ),
    profileAttach: { pid: 42, command: "node app", runtime: "node", seconds: 5 },
  });

  const [slice] = slicesOf([
    host("a", [
      snapshot({ sessions: [summary(session({ id: "s1", state: "needs-you" }), [request])] }),
    ]),
  ]);

  expect(slice?.need).toMatchObject({ requestId: "attach", kind: "question" });
});
