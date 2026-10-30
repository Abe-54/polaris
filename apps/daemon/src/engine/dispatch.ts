/**
 * `dispatch`: resolve what the decider needs from outside (attachments, a path
 * probe, Harness capabilities, an old Turn), decide and commit, ack, then fork
 * the command's reactor, serialized per session.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  Actor,
  Command,
  type CommandId,
  CommandRejected,
  type NotFound,
  type NotGranted,
  type Grant,
  RiskSummaryRef,
  type Sequence,
  TurnId,
  WorkspaceId,
} from "@polaris/protocol";
import { Context, Effect, Layer, Option, Predicate } from "effect";
import { sharedRevertRefusal } from "../accept/reactor.ts";
import { CommitResult } from "../store/EventStore.ts";
import type { ReadModel } from "../store/model.ts";
import { decide } from "./decider.ts";
import { Reactors } from "./reactors.ts";
import { EngineRuntime } from "./runtime.ts";
import { withSessionInput } from "./sessionBoundary.ts";
import { withWorkerAdmission } from "../resources/workerAdmission.ts";

export interface DispatchInput {
  readonly commandId: CommandId;
  readonly command: Command;
  /** Label of the sending Client device, from its `hello`. */
  readonly deviceLabel: string;
  /** Who sent it (ENG-398); a token-less Client when left out. */
  readonly actor?: Actor;
  readonly extensionGrant?: Grant | null;
}

export type Dispatch = (
  input: DispatchInput
) => Effect.Effect<{ readonly sequence: Sequence | null }, CommandRejected | NotFound | NotGranted>;

const probePath = (path: string) => {
  try {
    if (!statSync(path).isDirectory()) return { isDirectory: false, isGitRepo: false };
    let isGitRepo = false;

    try {
      statSync(join(path, ".git"));
      isGitRepo = true;
    } catch {}

    return { isDirectory: true, isGitRepo };
  } catch {
    return null;
  }
};

/** Commands that start a Turn: they wait at the session's boundary and need worker admission. */
const TURN_COMMANDS = [
  "SendTurn",
  "Continue",
  "Retry",
  "SendFeedback",
  "RunShellCommand",
  "CompactSession",
] as const;

const sessionOfCommand = (command: Command) => ("sessionId" in command ? command.sessionId : null);

const make = Effect.gen(function* () {
  const rt = yield* EngineRuntime;
  const { react } = yield* Reactors;
  const { store } = rt;

  const resolveAttachments = (commandId: CommandId, command: Command) =>
    Effect.gen(function* () {
      if (
        !Predicate.isTagged(command, "StartSession") &&
        !Predicate.isTagged(command, "SendTurn") &&
        !Predicate.isTagged(command, "SendFeedback") &&
        !Predicate.isTagged(command, "Steer")
      )
        return [];
      const ids = command.attachments ?? [];

      if (ids.length === 0) return [];

      const found = yield* rt.attachmentStore
        .get(ids)
        .pipe(
          Effect.mapError(
            (error) => new CommandRejected({ commandId, reason: `attachments: ${error.message}` })
          )
        );

      const byId = new Map(found.map((attachment) => [attachment.id, attachment]));
      const missing = ids.filter((id) => !byId.has(id));

      if (missing.length > 0) {
        return yield* new CommandRejected({
          commandId,
          reason: `unknown attachments: ${missing.join(", ")}`,
        });
      }

      return ids.flatMap((id) => byId.get(id) ?? []);
    });

  /** What the session's Harness driver declares, for the commands that depend on it. */
  const driverCan = (
    command: Command,
    tag:
      | "Steer"
      | "SetModel"
      | "StopBackgroundTasks"
      | "BackgroundCommand"
      | "RunShellCommand"
      | "CompactSession",
    can:
      | "steer"
      | "steerAttachments"
      | "switchModel"
      | "stopBackground"
      | "backgroundCommand"
      | "shellCommand"
      | "compact"
  ) =>
    Effect.gen(function* () {
      if (!Predicate.isTagged(command, tag)) return false;
      const model = yield* store.model;
      const record = model.sessions.get(command.sessionId);

      if (record === undefined) return false;
      const driver = yield* rt.registry.get(record.session.harness).pipe(Effect.option);

      return Option.isSome(driver) && driver.value.capabilities[can] === true;
    });

  /** For BackgroundCommand: the ids of the session's commands running now. */
  const runningCommands = (command: Command): ReadonlyArray<string> =>
    Predicate.isTagged(command, "BackgroundCommand")
      ? [...(rt.progress.get(command.sessionId)?.values() ?? [])].flatMap(({ item }) =>
          Predicate.isTagged(item, "CommandExecution") && item.status === "running" ? [item.id] : []
        )
      : [];

  const namedTurn = (command: Command) => {
    if (Predicate.isTagged(command, "ForkSession"))
      return rt.findTurn(command.fromSessionId, command.fromTurnId).pipe(Effect.orDie);

    if (Predicate.isTagged(command, "AcceptTurns"))
      return rt.findTurn(command.sessionId, command.throughTurnId).pipe(Effect.orDie);

    return Effect.succeed(null);
  };

  /** A revert that would clobber another Agent Session's files is refused before deciding. */
  const refuseSharedRevert = (commandId: CommandId, command: Command) =>
    Effect.gen(function* () {
      if (!Predicate.isTagged(command, "AcceptTurns")) return;

      const reason = yield* sharedRevertRefusal(store, command).pipe(
        Effect.catch((error) =>
          Effect.succeed(`couldn't check the other Agent Sessions here: ${error.message}`)
        )
      );

      if (reason !== null) return yield* new CommandRejected({ commandId, reason });
    });

  const judgedSummary = (command: Command) =>
    Predicate.isTagged(command, "RecordVerdict")
      ? store.review.riskSummary(RiskSummaryRef.cases.ById.make({ summaryId: command.summaryId }))
      : Effect.succeed(null);

  const commitCommand: Dispatch = Effect.fn("Engine.dispatch")(function* (input: DispatchInput) {
    const { commandId, command } = input;
    yield* refuseSharedRevert(commandId, command);

    const ctx = {
      commandId,
      now: yield* rt.now,
      deviceLabel: input.deviceLabel,
      actor: input.actor ?? Actor.cases.Client.make({}),
      extensionGrant: input.extensionGrant ?? null,
      newTurnId: TurnId.make(`turn_${crypto.randomUUID()}`),
      newWorkspaceId: WorkspaceId.make(`ws_${crypto.randomUUID()}`),
      attachments: yield* resolveAttachments(commandId, command),
      pathProbe: Predicate.isTagged(command, "RegisterWorkspace") ? probePath(command.path) : null,
      canSteer: yield* driverCan(command, "Steer", "steer"),
      canSteerAttachments: yield* driverCan(command, "Steer", "steerAttachments"),
      canSwitchModel: yield* driverCan(command, "SetModel", "switchModel"),
      canStopBackground: yield* driverCan(command, "StopBackgroundTasks", "stopBackground"),
      canBackgroundCommand: yield* driverCan(command, "BackgroundCommand", "backgroundCommand"),
      runningCommands: runningCommands(command),
      canRunShellCommand: yield* driverCan(command, "RunShellCommand", "shellCommand"),
      canCompact: yield* driverCan(command, "CompactSession", "compact"),
      namedTurn: yield* namedTurn(command),
      judgedSummary: yield* judgedSummary(command),
    };

    let before: ReadModel | null = null;

    const result = yield* store
      .commit({
        commandId,
        decide: (model) => {
          before = model;

          return decide(model, command, ctx);
        },
      })
      .pipe(Effect.catchTag("ServiceError", (error) => Effect.die(error)));

    if (CommitResult.$is("Committed")(result)) {
      const sessionId = sessionOfCommand(command);

      if (sessionId !== null && result.envelopes.length > 0)
        yield* rt.touchIdle(sessionId) ?? Effect.void;

      const reaction = react({
        command,
        result,
        before: before ?? result.model,
        attachments: ctx.attachments,
      }).pipe(
        Effect.catchCause((cause) => Effect.logError(`reacting to ${command._tag} failed`, cause))
      );

      yield* Effect.forkIn(
        sessionId === null ? reaction : rt.serially(sessionId)(reaction),
        rt.engineScope
      );
    }

    return { sequence: result.sequence };
  });

  const dispatch: Dispatch = (input) => {
    const command = input.command;

    const committed = Command.isAnyOf(TURN_COMMANDS)(command)
      ? withSessionInput(
          store,
          command.sessionId,
          commitCommand(input),
          Predicate.isTagged(command, "SendTurn")
            ? Effect.map(
                store.model,
                (model) =>
                  !model.sessions
                    .get(command.sessionId)
                    ?.turns.some((turn) => turn.status === "working")
              )
            : undefined
        )
      : commitCommand(input);

    if (!Command.isAnyOf(TURN_COMMANDS)(command)) return committed;

    return withWorkerAdmission(store, command.sessionId, committed).pipe(
      Effect.flatMap((result) =>
        result === undefined
          ? Effect.fail(
              new CommandRejected({
                commandId: input.commandId,
                reason: "Worker admission closed while input was queued",
              })
            )
          : Effect.succeed(result)
      )
    );
  };

  return Dispatcher.of({ dispatch });
});

export class Dispatcher extends Context.Service<Dispatcher, { readonly dispatch: Dispatch }>()(
  "polaris/daemon/engine/Dispatcher"
) {
  static readonly layer = Layer.effect(Dispatcher, make);
}
