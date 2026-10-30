/**
 * A shell command Turn (`RunShellCommand`) once its Harness is open: the command runs
 * outside the session's reactor lock (so Interrupt and steers reach it), then, back under
 * the lock, the Harness gets its output as the Turn's input and any steers held meanwhile.
 * The supervisor loads it when a session first runs a shell command.
 */
import type { SessionId, TurnId } from "@polaris/protocol";
import { Effect } from "effect";
import type { ShellCommandRun, TurnInput } from "../harness/HarnessDriver.ts";
import type { ServiceError } from "../services.ts";
import type { EngineRuntime } from "./runtime.ts";
import { beginShellJob, endShellJob, runShellJob, type ShellJob } from "./shellCommands.ts";

export interface ShellTurn {
  readonly sessionId: SessionId;
  readonly command: string;
  readonly turnInput: TurnInput;
}

export const shellTurns = (
  rt: EngineRuntime["Service"],
  /** Ends the Turn Interrupted, as the Harness would report it. */
  endInterrupted: (sessionId: SessionId, turnId: TurnId) => Effect.Effect<void, ServiceError>
) => {
  const deliver = (turn: ShellTurn, job: ShellJob, run: ShellCommandRun | null) =>
    Effect.gen(function* () {
      const { sessionId, turnInput } = turn;

      endShellJob(rt, job);

      const current = (yield* rt.store.model).sessions
        .get(sessionId)
        ?.turns.find((t) => t.id === turnInput.turnId);

      if (current?.status !== "working") return;

      if (run === null || job.interrupted)
        return yield* endInterrupted(sessionId, turnInput.turnId);

      const live = rt.live.get(sessionId);

      if (live === undefined)
        return yield* rt.failSession(sessionId, "The Harness stopped before it read the command");
      yield* live.session.sendTurn({ ...turnInput, shellCommand: run });

      for (const { text, attachments } of job.steers)
        yield* live.session
          .steer(text, attachments)
          .pipe(Effect.catch((error) => Effect.logWarning(`a held steer: ${error.message}`)));
    });

  /** Runs the command, then delivers it; forked, so the caller's lock is released meanwhile. */
  const start = (turn: ShellTurn) =>
    Effect.gen(function* () {
      // Before the fork: an Interrupt queued behind this reactor must find the job.
      const job = beginShellJob(rt, turn.sessionId, turn.turnInput.turnId);

      yield* runShellJob(rt, job, turn.command).pipe(
        Effect.flatMap((run) => rt.serially(turn.sessionId)(deliver(turn, job, run))),
        Effect.catch((error) =>
          rt.serially(turn.sessionId)(rt.failSession(turn.sessionId, error.message))
        ),
        // The Engine stopping ends the command and everything it started.
        Effect.onInterrupt(() => Effect.sync(() => job.controller.abort())),
        Effect.ensuring(Effect.sync(() => endShellJob(rt, job))),
        Effect.forkIn(rt.engineScope)
      );
    });

  return { start };
};
