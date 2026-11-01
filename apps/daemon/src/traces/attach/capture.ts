import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { ProfileError, type SessionId } from "@polaris/protocol";
import type { Profiles } from "../profiles/index.ts";
import type { TargetRegistry } from "./registry.ts";
import { EventStore } from "../../store/EventStore.ts";
import { workingTurn } from "../../store/model.ts";
import { approveAttach } from "./approval.ts";
import { attachError } from "./target.ts";

export const attachAttempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof ProfileError ? error : attachError("Inspector profiling failed."),
  });

export const captureAttached = Effect.fnUntraced(function* (
  sessionId: SessionId,
  pid: number,
  seconds: number,
  record: Profiles["Service"]["record"],
  targets: TargetRegistry,
  authorize: Effect.Effect<void, ProfileError>,
  initiator: "agent" | "user" = "agent"
) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30)
    return yield* attachError("Profile duration must be between 1 and 30 seconds.");

  const target = yield* Effect.try({
    try: () => targets.get(sessionId, pid),
    catch: () => attachError("This process is not registered. Restart with profiling instead."),
  });

  const turnId =
    initiator === "user"
      ? null
      : yield* approveAttach(sessionId, {
          pid,
          command: target.command,
          runtime: "node",
          seconds,
        });

  const events = yield* EventStore;

  const guard = Effect.gen(function* () {
    yield* authorize;
    const session = (yield* events.model).sessions.get(sessionId);

    if (!session || (turnId !== null && workingTurn(session)?.id !== turnId))
      return yield* attachError("The approved turn has ended.");
  });

  const changes = yield* events.subscribe({ sessionId });
  yield* guard;

  return yield* Effect.raceFirst(
    Effect.scoped(
      Effect.gen(function* () {
        const recording = yield* record(sessionId, {
          pid,
          command: target.command,
          runtime: "node",
        });

        const capture = yield* Effect.acquireRelease(
          attachAttempt(() => targets.open(target, seconds)),
          (handle) => attachAttempt(handle.close).pipe(Effect.ignore)
        );

        const profile = yield* attachAttempt(() => capture.profile);

        yield* attachAttempt(capture.close);
        yield* attachAttempt(() =>
          writeFile(join(recording.directory, "attach.cpuprofile"), profile, {
            mode: 0o600,
            flag: "wx",
          })
        );

        return yield* recording.finish;
      })
    ),
    changes.pipe(
      Stream.runForEach(() => guard),
      Effect.andThen(Effect.never)
    )
  );
});
