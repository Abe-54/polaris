/**
 * Re-records `fixtures/subagent-turn.jsonl`: a real Claude Code Turn (haiku)
 * that runs one foreground Subagent. The raw SDK frames go to
 * `$POLARIS_E2E_RECORD_SUBAGENT/frames.jsonl`; scrub paths and user names before
 * replacing the fixture. One tiny Turn (and its Subagent) is billed to the sign-in.
 *
 *   POLARIS_E2E_RECORD_SUBAGENT=/tmp/rec bun test subagentRecord.e2e
 */
import { tempDir } from "../../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query as sdkQuery, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionId, TurnId } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";

const out = process.env.POLARIS_E2E_RECORD_SUBAGENT;

const PROMPT =
  "Use the Agent tool exactly once, with run_in_background set to false, to spawn a " +
  "general-purpose subagent. Its job: list the files in the current directory with the Bash " +
  "tool, then reply with a short report that ends with the word pong. Do nothing else " +
  "yourself; when it finishes, reply with one sentence about what it found.";

test.skipIf(out === undefined)(
  "records a Turn with one foreground Subagent",
  async () => {
    const frames: Array<SDKMessage> = [];

    const driver = makeClaudeDriver({
      query: (args) => {
        const q = sdkQuery(args);
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
            cwd: tempDir("plr-"),
            permissionMode: "full-access",
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

          return yield* session.events.pipe(
            Stream.takeUntil(HarnessEvent.$is("TurnEnded")),
            Stream.runCollect
          );
        })
      )
    );

    const dir = out ?? "";

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "frames.jsonl"),
      `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`
    );
    expect(events.some(HarnessEvent.$is("SubagentEnded"))).toBe(true);
  },
  300_000
);
