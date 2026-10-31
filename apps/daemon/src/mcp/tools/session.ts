/** Tools over Agent Sessions rather than the graph: `read_worker` and `wait_for_command`. */
import { ConstellationRejected, type SessionId } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import type { McpBinding } from "../binding.ts";
import { sessionBinding } from "../binding.ts";
import { NotifyOutcome, WaitOutcome, type SessionTools } from "../sessions/index.ts";
import { splitRequestId, type Idempotency } from "./idempotency.ts";
import type { resolvers } from "./resolve.ts";
import {
  errorResult,
  inputRejection,
  jsonSchema,
  rejection,
  withRequestId,
  type BoundTool,
  type McpToolResult,
  type ConstellationCommands,
} from "./shared.ts";

/** Under Codex's default 60s MCP tool timeout, so a wait never reads as a failed call. */
export const WAIT_LIMIT_SECONDS = 50;

const DEFAULT_WAIT_SECONDS = 45;

export const text = (lines: ReadonlyArray<string>) => ({
  content: [{ type: "text" as const, text: lines.join("\n") }],
});

export const sessionTool = <S extends Schema.Decoder<unknown>>(
  name: string,
  description: string,
  schema: S,
  run: (input: S["Type"]) => Effect.Effect<McpToolResult, ConstellationRejected>
): BoundTool => ({
  name,
  description,
  inputSchema: jsonSchema(schema),
  call: (input) =>
    Effect.runPromise(
      Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() =>
          rejection(
            "E-INPUT",
            `Invalid input for ${name}`,
            "Use the fields in this tool's input schema."
          )
        ),
        Effect.flatMap(run),
        Effect.catchTag("ConstellationRejected", (error) => Effect.succeed(errorResult(error)))
      )
    ),
});

const notHere = rejection(
  "E-NOT-HERE",
  "This worker's session isn't on the Lead's Host",
  "read_worker reads workers on the Lead's Host for now; ask the worker with message instead."
);

/** Lead-only: cross-session reading stays with the Lead (owner decision on K1). */
export const readWorkerTool = (
  binding: McpBinding,
  commands: ConstellationCommands,
  resolve: ReturnType<typeof resolvers>,
  sessions: SessionTools
) =>
  sessionTool(
    "read_worker",
    "Read a worker's recent Turns as text: its prompts, replies, commands with their output tails, and file changes. Name it by short Task id or worker session name. turns is how many (default 2, at most 10); since starts from that Turn number to page back.",
    Schema.Struct({
      task: Schema.NonEmptyString,
      turns: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
      since: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    }),
    Effect.fnUntraced(function* (input) {
      const attemptId = yield* resolve.attempt(input.task);

      const current = yield* commands.status(
        sessionBinding(binding),
        binding.constellationId,
        true
      );

      const attempt = current.constellation?.attempts.find((a) => a.id === attemptId);

      if (attempt === undefined) return yield* notHere;

      const transcript = yield* sessions
        .transcript(attempt.sessionId, { turns: input.turns ?? 2, since: input.since ?? null })
        .pipe(
          Effect.mapError(() =>
            rejection("E-READ", "The worker's Turns couldn't be read", "Try again shortly.")
          )
        );

      if (transcript === null) return yield* notHere;

      return text([
        `Task ${attempt.taskId} · Attempt ${attempt.id}`,
        transcript,
        "Next: Steer with message, or review its Claim when it arrives.",
      ]);
    })
  );

const describeFinished = (outcome: Extract<WaitOutcome, { _tag: "Finished" }>) =>
  outcome.finished.flatMap(({ task, command }) => {
    if (command === null) return [`Finished: ${task.description}`];
    const exit = command.exitCode === null ? command.status : `exit ${command.exitCode}`;
    const tail = command.output.trimEnd().split("\n").slice(-20).join("\n");

    return [`Finished: ${task.description} (${exit})`, ...(tail === "" ? [] : [tail])];
  });

const waitText = (outcome: WaitOutcome, seconds: number) =>
  WaitOutcome.$match(outcome, {
    Unavailable: () =>
      Effect.fail(rejection("E-NOT-READY", "Waiting isn't connected", "Continue without waiting.")),
    NotFound: () =>
      Effect.fail(
        rejection("E-SESSION", "This session isn't on this Host", "Continue without waiting.")
      ),
    Idle: ({ task }) =>
      Effect.succeed(
        text([
          task === null
            ? "No background commands are running."
            : `No background command ${task} is running; it may have finished already.`,
          "Next: Continue.",
        ])
      ),
    Finished: (finished) =>
      Effect.succeed(text([...describeFinished(finished), "Next: Continue with the results."])),
    Running: ({ running }) =>
      Effect.succeed(
        text([
          `Still running after ${seconds}s:`,
          ...running.map((task) => `- ${task.id}: ${task.description}`),
          "Next: Call wait_for_command again to keep waiting, or continue other work.",
        ])
      ),
  });

/** Every binding: a Codex session has no Monitor of its own to wait on its background commands. */
export const waitForCommandTool = (sessionId: SessionId, sessions: SessionTools) =>
  sessionTool(
    "wait_for_command",
    `Wait until this session's background commands finish, instead of polling them: all of them, or the one whose id is task. Returns each finished command's exit and output tail, or what is still running after timeoutSeconds (default ${DEFAULT_WAIT_SECONDS}, at most ${WAIT_LIMIT_SECONDS}); call again to keep waiting.`,
    Schema.Struct({
      task: Schema.optionalKey(Schema.NonEmptyString),
      timeoutSeconds: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: WAIT_LIMIT_SECONDS }))
      ),
    }),
    (input) => {
      const seconds = input.timeoutSeconds ?? DEFAULT_WAIT_SECONDS;

      return sessions
        .waitForCommand(sessionId, { task: input.task ?? null, timeoutMs: seconds * 1000 })
        .pipe(Effect.flatMap((outcome) => waitText(outcome, seconds)));
    }
  );

const NotifyInputSchema = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  body: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(400))),
});

const notifyText = (outcome: NotifyOutcome) =>
  NotifyOutcome.$match(outcome, {
    Sent: () => Effect.succeed(text(["Notification sent.", "Next: Continue."])),
    AlreadySent: () =>
      Effect.succeed(text(["This notification was already sent.", "Next: Continue."])),
    Collapsed: () =>
      Effect.succeed(
        text([
          "Polaris already notified the user about this session moments ago, so this one was folded into it.",
          "Next: Continue.",
        ])
      ),
    NotFound: () =>
      Effect.fail(
        rejection("E-SESSION", "This session can't notify", "Continue without notifying.")
      ),
    RateLimited: ({ retryInSeconds }) =>
      Effect.fail(
        rejection(
          "E-RATE",
          "This session notified the user moments ago",
          `Fold this into your next update, or notify again in ${retryInSeconds}s.`
        )
      ),
  });

/** Every binding: a notification on the user's Mac and phone, at most one per 30s per session. */
export const notifyTool = (
  sessionId: SessionId,
  sessions: SessionTools,
  ids: Idempotency
): BoundTool => {
  const send = (rest: typeof Schema.Json.Type, requestId: string | undefined) =>
    Schema.decodeUnknownEffect(NotifyInputSchema)(rest, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => inputRejection("notify")),
      Effect.flatMap((decoded) => {
        const call = ids.begin(sessionId, "notify", requestId, rest);

        return sessions
          .notify(sessionId, { title: decoded.title, body: decoded.body ?? "" }, call.id)
          .pipe(
            Effect.mapError(() =>
              rejection("E-NOTIFY", "The notification couldn't be recorded", "Try again.")
            ),
            Effect.flatMap(notifyText),
            Effect.tapError(() => Effect.sync(call.rejected))
          );
      })
    );

  return {
    name: "notify",
    description:
      "Send the user a notification on their desktop and phone: a short title and an optional body. Use it for news the user would want while away (done, blocked, needs a decision), not for progress. Polaris already notifies the user of your questions to them, approvals and handed-up Claims; don't repeat those. At most one every 30s per session.",
    inputSchema: withRequestId(jsonSchema(NotifyInputSchema)),
    call: (input) =>
      Effect.runPromise(
        splitRequestId(input).pipe(
          Effect.mapError(() => inputRejection("notify")),
          Effect.flatMap(({ requestId, rest }) => send(rest, requestId)),
          Effect.catchTag("ConstellationRejected", (error) => Effect.succeed(errorResult(error)))
        )
      ),
  };
};
