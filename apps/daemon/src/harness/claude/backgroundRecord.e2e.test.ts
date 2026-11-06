import { tempDir } from "../../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query as sdkQuery, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionId, TurnId, TurnTrigger } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";

const out = process.env.POLARIS_E2E_RECORD_BACKGROUND;

const command = process.env.POLARIS_E2E_BACKGROUND_KIND === "command";

const PROMPT = command
  ? "Use Bash exactly once to run sleep 12 with run_in_background:true. Immediately end with only launched. " +
    "When its task notification arrives, respond with command continuation pong. Do no other work."
  : "Use Agent exactly once with run_in_background:true and subagent_type:general-purpose. " +
    "Its prompt: Run Bash sleep 12 with run_in_background:false, then report **background pong**. " +
    "After launching it, immediately end your response with only launched. When its task notification " +
    "arrives, respond with the report and the words continuation pong. Do no other work.";

test.skipIf(out === undefined)(
  "records a background task and the Harness's continuation",
  async () => {
    const frames: SDKMessage[] = [];

    const driver = makeClaudeDriver({
      query: (args) => {
        const q = sdkQuery({
          ...args,
          options: {
            ...args.options,
            permissionMode: "dontAsk",
            allowedTools: ["Agent", "Bash(sleep *)"],
            settingSources: [],
            mcpServers: {},
            persistSession: false,
          },
        });

        const iterator = q[Symbol.asyncIterator]();

        return Object.assign(q, {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              const r = await iterator.next();

              if (r.done !== true) frames.push(r.value);

              return r;
            },
          }),
        });
      },
    });

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* driver.open({
            sessionId: SessionId.make("rec"),
            cwd: tempDir("polaris-bg-"),
            permissionMode: "supervised",
            model: "haiku",
            effort: null,
            resumeCursor: null,
          });

          yield* session.sendTurn({
            turnId: TurnId.make("t1"),
            prompt: PROMPT,
            attachments: [],
            model: "haiku",
            effort: null,
          });
          let ended = 0;

          return yield* session.events.pipe(
            Stream.takeUntil((e) => HarnessEvent.$is("TurnEnded")(e) && ++ended === 2),
            Stream.runCollect
          );
        })
      ).pipe(Effect.timeout("90 seconds"))
    );

    mkdirSync(out!, { recursive: true });
    writeFileSync(
      join(out!, "frames.jsonl"),
      frames.map((f) => JSON.stringify(f)).join("\n") + "\n"
    );
    expect(events.filter(HarnessEvent.$is("TurnStarted"))).toHaveLength(2);
    const trigger = events.filter(HarnessEvent.$is("TurnStarted"))[1]?.trigger;

    expect(
      trigger &&
        TurnTrigger.guards.BackgroundTasksReported(trigger) &&
        trigger.tasks.map((t) => t.kind)
    ).toEqual([command ? "command" : "subagent"]);

    if (!command)
      expect(events.find(HarnessEvent.$is("SubagentEnded"))?.report).toContain("background pong");
  },
  100_000
);
