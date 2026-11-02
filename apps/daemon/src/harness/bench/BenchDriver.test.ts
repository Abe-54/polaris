import { tempDir } from "../../platform/tempDir.testing.ts";
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalDecision, SessionId, TurnId } from "@polaris/protocol";
import { Effect, Fiber, Option, Stream } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import {
  BENCH_PROMPT_PREFIX,
  benchTurnEnd,
  DEFAULT_SCRIPT,
  makeBenchDriver,
  parseScript,
} from "./BenchDriver.ts";

describe("parseScript", () => {
  test("reads a bench: prompt over the defaults, and falls back on anything else", () => {
    expect(parseScript(`${BENCH_PROMPT_PREFIX}{"items":3}`)).toEqual({
      ...DEFAULT_SCRIPT,
      items: 3,
    });
    expect(parseScript("Fix the flaky test")).toEqual(DEFAULT_SCRIPT);
    expect(parseScript(`${BENCH_PROMPT_PREFIX}{not json`)).toEqual(DEFAULT_SCRIPT);
  });
});

describe("benchTurnEnd", () => {
  test("a usageLimit script fails the Turn at a limit, with its reset or none", () => {
    const turnId = TurnId.make("t1");

    expect(benchTurnEnd(turnId, DEFAULT_SCRIPT)).toMatchObject({ status: "completed" });
    expect(benchTurnEnd(turnId, { ...DEFAULT_SCRIPT, usageLimit: true })).toMatchObject({
      status: "failed",
      limit: { resetsAt: null },
    });

    const timed = benchTurnEnd(turnId, {
      ...DEFAULT_SCRIPT,
      usageLimit: true,
      usageLimitResetsInMs: 60_000,
    });

    expect(
      HarnessEvent.$is("TurnEnded")(timed) && Date.parse(timed.limit?.resetsAt ?? "")
    ).toBeGreaterThan(Date.now());
  });
});

describe("bench Harness", () => {
  test("streams a scripted Turn, waits on its approval, and touches files", async () => {
    const cwd = tempDir("polaris-bench-driver-");

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = makeBenchDriver("codex");

          const session = yield* driver.open({
            sessionId: SessionId.make("s1"),
            cwd,
            permissionMode: "supervised",
            model: null,
            effort: null,
            resumeCursor: null,
          });

          const seen: Array<HarnessEvent> = [];

          const consumer = yield* session.events.pipe(
            Stream.tap((event) =>
              Effect.gen(function* () {
                seen.push(event);

                if (HarnessEvent.$is("ApprovalRequested")(event)) {
                  yield* session.respond(
                    event.requestId,
                    ApprovalDecision.cases.Allow.make({ remember: false })
                  );
                }
              })
            ),
            Stream.takeUntil(HarnessEvent.$is("TurnEnded")),
            Stream.runDrain,
            Effect.forkScoped
          );

          yield* session.sendTurn({
            turnId: TurnId.make("t1"),
            prompt: `${BENCH_PROMPT_PREFIX}${JSON.stringify({
              items: 5,
              deltasPerItem: 3,
              deltaBytes: 32,
              deltaIntervalMs: 0,
              approvalEvery: 2,
              touchFiles: 2,
            })}`,
            attachments: [],
            model: null,
            effort: null,
          });
          yield* Fiber.join(consumer);

          return seen;
        })
      )
    );

    const tags = events.map((e) => e._tag);
    expect(tags[0]).toBe("CursorAssigned");
    expect(tags[1]).toBe("TurnStarted");
    expect(tags.at(-1)).toBe("TurnEnded");
    expect(tags.filter((t) => t === "ItemCompleted")).toHaveLength(5);
    // Items 0–2 of every five stream deltas: 3 items × 3 deltas.
    const deltas = events.filter(HarnessEvent.$is("ItemDelta"));
    expect(deltas).toHaveLength(9);

    for (const d of deltas) {
      expect(d.text).toHaveLength(32);
      expect(d.text).toMatch(/^@\d+\.\d+\|x+$/);
    }

    expect(events.filter(HarnessEvent.$is("ApprovalRequested"))).toHaveLength(2);
    expect(readdirSync(join(cwd, "polaris-bench"))).toHaveLength(2);
  });

  test("interrupt ends the Turn in flight as interrupted", async () => {
    const end = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeBenchDriver("claude").open({
            sessionId: SessionId.make("s2"),
            cwd: tmpdir(),
            permissionMode: "supervised",
            model: null,
            effort: null,
            resumeCursor: "cursor",
          });

          yield* session.sendTurn({
            turnId: TurnId.make("t1"),
            prompt: `${BENCH_PROMPT_PREFIX}{"items":100,"deltaIntervalMs":50}`,
            attachments: [],
            model: null,
            effort: null,
          });

          const ended = yield* session.events.pipe(
            Stream.tap((event) =>
              HarnessEvent.$is("TurnStarted")(event) ? session.interrupt : Effect.void
            ),
            Stream.filter(HarnessEvent.$is("TurnEnded")),
            Stream.runHead
          );

          return ended;
        })
      )
    );

    expect(Option.map(end, (e) => e.status)).toEqual(Option.some("interrupted"));
  });
});
