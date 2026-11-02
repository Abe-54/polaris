import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SessionId, SubagentId, TurnId } from "@polaris/protocol";
import { Effect, Predicate, Stream } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeCodexDriver } from "./CodexDriver.ts";
import { agentName, CodexSubagents } from "./subagents.ts";
import { readFixture, replay, startFakeAppServer } from "./testing/FakeAppServer.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const T1 = TurnId.make("turn-1");

const CHILD = "01a0eb9c-da4d-7351-b059-fef46771a207";

describe("Codex Subagents", () => {
  test("a recorded Turn that spawns one agent: its thread's items are the Subagent's", async () => {
    // Recorded from codex-cli 0.158.0 (multi-agent v2), paths and account notifications scrubbed.
    const frames = await readFixture(join(import.meta.dir, "fixtures/subagent-turn.jsonl"));
    const dir = newTempDir("pcs-", { short: true });
    cleanup.push(() => removeTempDir(dir));
    const server = startFakeAppServer(join(dir, "s.sock"), replay(frames));
    cleanup.push(server.stop);
    const events: Array<HarnessEvent> = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* makeCodexDriver({
            socketPath: join(dir, "s.sock"),
            spawnAppServer: false,
            codexPath: "/opt/codex",
          });

          const session = yield* driver.open({
            sessionId: SessionId.make("s1"),
            cwd: "/repo",
            permissionMode: "full-access",
            model: "gpt-6-sol",
            effort: null,
            resumeCursor: null,
          });

          yield* session.events.pipe(
            Stream.runForEach((e) => Effect.sync(() => events.push(e))),
            Effect.forkDetach
          );
          yield* session.sendTurn({
            turnId: T1,
            prompt: "Spawn exactly one subagent",
            attachments: [],
            model: "gpt-6-sol",
            effort: "low",
          });

          while (!events.some(HarnessEvent.$is("TurnEnded"))) yield* Effect.sleep("10 millis");
        })
      )
    );

    const sub = SubagentId.make(CHILD);

    const trace = events.flatMap((e) => {
      if (HarnessEvent.$is("SubagentStarted")(e)) return [`started ${e.subagentId} ${e.title}`];

      if (HarnessEvent.$is("SubagentEnded")(e)) return [`ended ${e.subagentId} ${e.status}`];

      if (HarnessEvent.$is("ItemCompleted")(e) && Predicate.isTagged(e.item, "AssistantMessage")) {
        return [`message ${e.subagentId ?? "turn"} ${e.item.text}`];
      }

      return HarnessEvent.$is("TurnEnded")(e) ? [`TurnEnded ${e.turnId} ${e.status}`] : [];
    });

    expect(trace).toEqual([
      `started ${sub} pong`,
      `message ${sub} pong`,
      `ended ${sub} completed`,
      "message turn pong",
      `TurnEnded ${T1} completed`,
    ]);
    // The agent's own turn is not a second Polaris Turn.
    expect(events.flatMap((e) => (HarnessEvent.$is("TurnStarted")(e) ? [e.turnId] : []))).toEqual([
      T1,
    ]);
    // One delta streams the agent's reply, the other the Turn's own.
    expect(events.flatMap((e) => (HarnessEvent.$is("ItemDelta")(e) ? [e.subagentId] : []))).toEqual(
      [sub, undefined]
    );
  });

  test("v1 collab calls: spawnAgent starts one per thread, agentsStates end them", () => {
    const subagents = new CodexSubagents();

    const call = (tool: string, states: Record<string, { status: string }>) => ({
      type: "collabAgentToolCall" as const,
      id: `call-${tool}`,
      tool,
      status: "completed",
      prompt: tool === "spawnAgent" ? "Check the frame timing\nat 180 Hz" : null,
      receiverThreadIds: tool === "spawnAgent" ? ["thr-a", "thr-b"] : [],
      model: "gpt-6-luna",
      agentsStates: states,
    });

    const started = subagents.fromParentItem(T1, call("spawnAgent", {}));

    expect(started).toEqual([
      HarnessEvent.SubagentStarted({
        turnId: T1,
        subagentId: SubagentId.make("thr-a"),
        parentItemId: "call-spawnAgent",
        title: "Check the frame timing",
        agent: null,
        model: "gpt-6-luna",
      }),
      HarnessEvent.SubagentStarted({
        turnId: T1,
        subagentId: SubagentId.make("thr-b"),
        parentItemId: "call-spawnAgent",
        title: "Check the frame timing",
        agent: null,
        model: "gpt-6-luna",
      }),
    ]);

    const ended = subagents.fromParentItem(
      T1,
      call("wait", { "thr-a": { status: "completed" }, "thr-b": { status: "errored" } })
    );

    expect(ended.map((e) => (HarnessEvent.$is("SubagentEnded")(e) ? e.status : e._tag))).toEqual([
      "completed",
      "failed",
    ]);
    expect(subagents.scopeOf("thr-a")).toEqual({
      turnId: T1,
      subagentId: SubagentId.make("thr-a"),
    });
    expect(subagents.scopeOf("thr-other")).toBeUndefined();
    expect(agentName("/root/pong")).toBe("pong");
  });
});
