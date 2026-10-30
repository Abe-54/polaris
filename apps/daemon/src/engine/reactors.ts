/**
 * Reactors: what the engine does after a command commits (and after its ack):
 * open Harnesses and hand them Turns, create or remove Worktrees, prune
 * checkpoints, hand sessions to and from the terminal.
 */
import {
  type Attachment,
  type ApprovalDecision,
  type ApprovalRequest,
  Command,
  DomainEvent,
  type EventEnvelope,
  type NotFound,
  type SessionId,
  type Turn,
} from "@polaris/protocol";
import { Context, Effect, Inspectable, Layer, Predicate } from "effect";
import { revertAfterAccept } from "../accept/reactor.ts";
import { sessionRestartNote } from "../constellation/restartNote.ts";
import type { HarnessError } from "../harness/HarnessDriver.ts";
import type { ServiceError } from "../services.ts";
import type { CommitResult } from "../store/EventStore.ts";
import type { ReadModel } from "../store/model.ts";
import { CONTINUE_PROMPT } from "./decider.ts";
import { CheckpointPruning } from "./pruning.ts";
import { ReviewCheckouts } from "./reviewCheckouts.ts";
import { EngineRuntime } from "./runtime.ts";
import { SecretRequests } from "./secretRequests.ts";
import { Supervisor } from "./supervisor.ts";
import { TerminalHandoff } from "./terminal.ts";
import { Worktrees } from "./worktrees.ts";

export type Reaction = Effect.Effect<void, ServiceError | HarnessError | NotFound>;

/** A command that committed, and the model it was decided against. */
export interface Committed {
  readonly command: Command;
  readonly result: Extract<CommitResult, { _tag: "Committed" }>;
  readonly before: ReadModel;
  readonly attachments?: ReadonlyArray<Attachment>;
}

type CommandOf<Tag extends Command["_tag"]> = Extract<Command, { _tag: Tag }>;

const turnFrom = (envelopes: ReadonlyArray<EventEnvelope>): Turn | undefined => {
  for (const envelope of envelopes) {
    if (Predicate.isTagged(envelope.event, "TurnStarted")) return envelope.event.turn;
  }

  return undefined;
};

const make = Effect.gen(function* () {
  const rt = yield* EngineRuntime;
  const supervisor = yield* Supervisor;
  const terminal = yield* TerminalHandoff;
  const worktrees = yield* Worktrees;
  const pruning = yield* CheckpointPruning;
  const checkouts = yield* ReviewCheckouts;
  const secrets = yield* SecretRequests;
  const { live } = rt;

  const runStartedTurn = (sessionId: SessionId, envelopes: ReadonlyArray<EventEnvelope>) => {
    const turn = turnFrom(envelopes);

    return turn === undefined
      ? Effect.void
      : supervisor.runTurn({
          sessionId,
          turnId: turn.id,
          prompt: turn.prompt,
          attachments: turn.attachments,
          shellCommand: turn.shellCommand,
        });
  };

  const registerWorkspace = ({ result }: Committed) =>
    Effect.gen(function* () {
      const workspace = result.envelopes
        .map((e) => e.event)
        .find(DomainEvent.isAnyOf(["WorkspaceRegistered"]))?.workspace;

      if (workspace === undefined || !workspace.isGitRepo) return;
      yield* worktrees.detectExisting(workspace);
    });

  const startSession = (command: CommandOf<"StartSession">, { result }: Committed) =>
    Effect.gen(function* () {
      const record = result.model.sessions.get(command.sessionId);
      const workspace = result.model.workspaces.get(command.workspaceId);
      const turn = turnFrom(result.envelopes);

      if (record === undefined || workspace === undefined || turn === undefined) return;

      if (Predicate.isTagged(command.placement, "NewWorktree")) {
        const created = yield* worktrees.create(command.sessionId, workspace, {
          path: record.session.cwd,
          branch: command.placement.branch.trim(),
          baseRef: command.placement.baseRef,
        });

        if (!created) return;
      }

      yield* supervisor.runTurn({
        sessionId: command.sessionId,
        turnId: turn.id,
        prompt: turn.prompt,
        attachments: turn.attachments,
      });
    }).pipe(
      // A crash while starting must not leave the session Starting: it Fails, saying why.
      Effect.catchDefect((defect) =>
        rt.failSession(
          command.sessionId,
          `The session couldn't start: ${
            defect instanceof Error ? defect.message : Inspectable.toStringUnknown(defect)
          }`
        )
      )
    );

  /** Continue resumes the same Turn; after a restart it names the background work that was lost. */
  const continueTurn = (sessionId: SessionId, { result }: Committed) =>
    Effect.gen(function* () {
      const turn = turnFrom(result.envelopes);

      if (turn === undefined) return;
      // Read as of just before this commit: its TurnStarted would clear the note.
      const before = result.envelopes[0]!.sequence - 1;
      const note = yield* sessionRestartNote(rt.store, sessionId, before);
      yield* supervisor.runTurn({
        sessionId,
        turnId: turn.id,
        prompt: note === null ? CONTINUE_PROMPT : `${CONTINUE_PROMPT}\n\n${note}`,
        attachments: [],
      });
    });

  const interrupt = (sessionId: SessionId) =>
    Effect.gen(function* () {
      // A shell command still running (or not yet read) is the Turn's to stop.
      const shell = rt.shellJobs.get(sessionId);

      if (shell !== undefined) return shell.interrupt();
      const entry = live.get(sessionId);

      if (entry !== undefined) return yield* entry.session.interrupt;
      // No Harness is running the Turn; end it here.
      yield* rt.signal(sessionId, { type: "turn.interruptUnattended", at: yield* rt.now });
    });

  /** The live Harness stops the tasks; its next `BackgroundTasksChanged` drops them. */
  const stopBackground = (sessionId: SessionId, taskIds: ReadonlyArray<string> | null) =>
    Effect.gen(function* () {
      const entry = live.get(sessionId);
      const record = (yield* rt.store.model).sessions.get(sessionId);

      if (entry?.session.stopBackground === undefined || record === undefined) return;
      const ids = taskIds ?? record.session.backgroundTasks.map((task) => task.id);
      yield* entry.session.stopBackground(ids);
    });

  /** Claude Code ends the command's tool call at once, and reports it as a background task. */
  const backgroundCommand = (sessionId: SessionId, itemId: string | null) =>
    Effect.gen(function* () {
      const session = live.get(sessionId)?.session;

      if (session?.backgroundCommand === undefined) return;
      const moved = yield* session.backgroundCommand(itemId);

      if (!moved) yield* Effect.logWarning(`${sessionId}: ${itemId} was no longer running`);
    }).pipe(
      Effect.catchTag("HarnessError", (error) =>
        Effect.logWarning(`couldn't run in the background: ${error.message}`)
      )
    );

  const respond = (
    sessionId: SessionId,
    requestId: ApprovalRequest["id"],
    decision: ApprovalDecision
  ) =>
    Effect.gen(function* () {
      // Polaris opened it, not the Harness: its waiting `request_secret` reads the answer.
      if (secrets.owns(requestId)) return;
      const entry = live.get(sessionId);

      if (entry === undefined) {
        return yield* Effect.logWarning(
          `no running Harness for ${sessionId} to answer ${requestId}`
        );
      }

      yield* entry.session.respond(requestId, decision);
    });

  const archive = (command: CommandOf<"ArchiveSession">) =>
    Effect.gen(function* () {
      const { sessionId } = command;
      yield* rt.cancelIdle(sessionId);
      yield* rt.stopHarness(sessionId);
      yield* terminal.stopFollower(sessionId, false);
      rt.terminalLaunch.delete(sessionId);
      yield* secrets.files.forget(sessionId);
      const model = yield* rt.store.model;
      yield* worktrees.removeArchived(sessionId, model, command.deleteMergedBranch);
      const record = model.sessions.get(sessionId);
      const workspace = record && model.workspaces.get(record.session.workspaceId);

      if (record !== undefined && workspace?.isGitRepo) {
        yield* pruning.onArchived(record, workspace, model);
      }

      yield* rt.attachmentStore.onSessionArchived(sessionId);
    });

  const removeWorkspace = (command: CommandOf<"RemoveWorkspace">, { before }: Committed) =>
    Effect.suspend(() => {
      // The removal purged the Workspace and its sessions, so look them up in the model before it.
      const workspace = before.workspaces.get(command.workspaceId);
      const staged = rt.attachmentStore.onWorkspaceRemoved(command.workspaceId);

      if (workspace === undefined || !workspace.isGitRepo) return staged;

      const sessionIds = [...before.sessions.values()].flatMap((record) =>
        record.session.workspaceId === workspace.id ? [record.session.id] : []
      );

      return Effect.all(
        [
          pruning.onWorkspaceRemoved(workspace, sessionIds),
          checkouts.workspaceRemoved(workspace),
          staged,
        ],
        { discard: true }
      );
    });

  /** Run the reactor for a command that committed. */
  const react = (committed: Committed): Reaction =>
    Command.match<Reaction>(committed.command, {
      RegisterWorkspace: () => registerWorkspace(committed),
      StartSession: (command) => startSession(command, committed),
      SendTurn: (command) => {
        const record = committed.before.sessions.get(command.sessionId);

        const autonomous = record?.turns.find(
          (turn) => turn.status === "working" && turn.trigger !== null
        );

        return autonomous === undefined
          ? runStartedTurn(command.sessionId, committed.result.envelopes)
          : supervisor.runTurn({
              sessionId: command.sessionId,
              turnId: autonomous.id,
              prompt: command.prompt,
              attachments: committed.attachments ?? [],
              steerExisting: true,
            });
      },
      Continue: (command) => continueTurn(command.sessionId, committed),
      Retry: (command) => runStartedTurn(command.sessionId, committed.result.envelopes),
      RunShellCommand: (command) => runStartedTurn(command.sessionId, committed.result.envelopes),
      CompactSession: (command) => runStartedTurn(command.sessionId, committed.result.envelopes),
      Steer: (command) =>
        Effect.suspend(() => {
          const shell = rt.shellJobs.get(command.sessionId);

          const attachments = committed.attachments ?? [];

          if (shell === undefined)
            return (
              live.get(command.sessionId)?.session.steer(command.text, attachments) ?? Effect.void
            );
          shell.steers.push({ text: command.text, attachments });

          return Effect.void;
        }),
      Interrupt: (command) => interrupt(command.sessionId),
      StopBackgroundTasks: (command) => stopBackground(command.sessionId, command.taskIds),
      BackgroundCommand: (command) => backgroundCommand(command.sessionId, command.itemId),
      RespondToApproval: (command) =>
        respond(command.sessionId, command.requestId, command.decision),
      SetPermissionMode: (command) =>
        Effect.suspend(
          () =>
            live.get(command.sessionId)?.session.setPermissionMode(command.permissionMode) ??
            Effect.void
        ),
      // The next Turn carries the Model and effort to the Harness (TurnInput).
      SetModel: () => Effect.void,
      ArchiveSession: archive,
      OpenInTerminal: (command) => terminal.openInTerminal(command.sessionId),
      ReturnFromTerminal: (command) => terminal.returnFromTerminal(command.sessionId),
      ForkSession: (command) => worktrees.createForFork(command, committed.result.model),
      UnarchiveSession: (command) => worktrees.restore(command.sessionId),
      RemoveWorkspace: (command) => removeWorkspace(command, committed),
      SetWorktreeSetup: () => Effect.void,
      SetWorkspaceHidden: () => Effect.void,
      RenameSession: () => Effect.void,
      PinSession: () => Effect.void,
      // LimitResume follows the committed event and schedules the Continue.
      SetResumeAtReset: () => Effect.void,
      SendFeedback: (command) => runStartedTurn(command.sessionId, committed.result.envelopes),
      AcceptTurns: (command) => revertAfterAccept(rt.store, command),
      LinkPullRequest: () => Effect.void,
      OpenReviewCheckout: (command) => checkouts.opened(command.checkoutId),
      // A new head makes the checkout stale; updating it is the user's call.
      ReportReviewHead: () => Effect.void,
      UpdateReviewCheckout: (command) =>
        checkouts.updated(command.checkoutId, command.discardChanges, committed.before),
      RemoveReviewCheckout: (command) => checkouts.removed(command.checkoutId),
      RecordVerdict: () => Effect.void,
    });

  return Reactors.of({ react });
});

/** What runs after a command commits. */
export class Reactors extends Context.Service<
  Reactors,
  { readonly react: (committed: Committed) => Reaction }
>()("polaris/daemon/engine/Reactors") {
  static readonly layer = Layer.effect(Reactors, make);
}
