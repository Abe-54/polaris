/**
 * Supervises each Agent Session's Harness: opens it, hands it Turns, and maps
 * the `HarnessEvent`s it (or a followed terminal UI) reports to domain events
 * and session machine inputs.
 */
import {
  type AgentSession,
  ApprovalRequest,
  type Attachment,
  Compaction,
  DomainEvent,
  NotFound,
  type SessionId,
  Subagent,
  type TurnId,
  Worktree,
} from "@polaris/protocol";
import { Context, Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import { SecretRequests } from "./secretRequests.ts";
import { type HarnessError, HarnessEvent } from "../harness/HarnessDriver.ts";
import { ApprovalPolicy, type ServiceError } from "../services.ts";
import {
  ConstellationHarness,
  type ConstellationHarnessService,
} from "../constellation/composition/attachments.ts";
import {
  ConstellationLiveness,
  type ConstellationLivenessService,
} from "../constellation/liveness.ts";
import { LiveItem } from "../store/EventStore.ts";
import { workingTurn } from "../store/model.ts";
import { UsageIndex } from "../usage/service.ts";
import { isWorker, usageLimitOf } from "./limits.ts";
import { worktreeIdFor } from "./decider.ts";
import { contextChanged, contextUsageOf } from "./context.ts";
import { finalReply, forkPreamble } from "./fork.ts";
import { EngineRuntime, type EventSource, type LiveHarness, type Progress } from "./runtime.ts";
import { deferredUserTurns, refuseUserTurn } from "./supervisor.turns.ts";
import { HarnessTurnAliases } from "./supervisor.aliases.ts";
import type { ShellTurn } from "./supervisor.shell.ts";
import { DEFAULT_HARNESS_START_TIMEOUT, timedStart } from "./supervisor.start.ts";
import { shortHostName } from "../service/hostName.ts";

type HarnessEventOf<Tag extends HarnessEvent["_tag"]> = Extract<HarnessEvent, { _tag: Tag }>;

export interface TurnToRun {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly steerExisting?: boolean;
  /** The user's shell command the Turn runs before the Harness reads it (`RunShellCommand`). */
  readonly shellCommand?: string | null;
}

const make = (
  rt: EngineRuntime["Service"],
  policy: Option.Option<ApprovalPolicy["Service"]>,
  attachments: ConstellationHarnessService,
  liveness: ConstellationLivenessService,
  usage: Option.Option<UsageIndex["Service"]>,
  secrets: SecretRequests["Service"]
): Supervisor["Service"] => {
  const { store, live, progress } = rt;
  // A live secret printed by a command never reaches the log or a Client (ADR 0089).
  const redact = secrets.files.redact;
  const redactText = secrets.files.redactText;
  const redactNullable = (text: string | null) => (text === null ? null : redactText(text));

  /** True when the policy answered the request itself, on the session's live Harness. */
  const answeredByPolicy = (
    sessionId: SessionId,
    entry: EventSource,
    e: HarnessEventOf<"ApprovalRequested">
  ) =>
    Effect.gen(function* () {
      const harness = live.get(sessionId);

      if (Option.isNone(policy) || harness === undefined || harness !== entry) return false;
      const record = (yield* store.model).sessions.get(sessionId);

      if (record === undefined) return false;

      const decision = yield* policy.value.decide({
        sessionId,
        harness: record.session.harness,
        kind: e.kind,
        title: e.title,
        detail: e.detail,
      });

      if (decision === null) return false;
      yield* harness.session
        .respond(e.requestId, decision)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("answering an approval by policy failed", cause)
          )
        );

      return true;
    });

  const openHarness = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const existing = live.get(sessionId);

      if (existing !== undefined) return existing;
      const model = yield* store.model;
      const record = model.sessions.get(sessionId);

      if (record === undefined) {
        return yield* new NotFound({ what: "session", id: sessionId });
      }

      const driver = yield* rt.registry.get(record.session.harness);
      const readOnly = Option.isSome(policy) && policy.value.readOnly(sessionId);

      const supportsConstellations =
        record.session.harness === "codex" || record.session.harness === "claude";

      const attachment = yield* attachments.open(sessionId, readOnly || !supportsConstellations);
      const scope = yield* Scope.make();

      const session = yield* driver
        .open({
          sessionId,
          ...attachment,
          cwd: record.session.cwd,
          permissionMode: record.session.permissionMode,
          model: record.session.model,
          effort: record.session.effort,
          serviceTier: record.session.serviceTier,
          resumeCursor: record.session.harnessCursor,
          readOnly,
        })
        .pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void))
        );

      const entry: LiveHarness = { driver, session, scope, consumer: null, stopping: false };
      live.set(sessionId, entry);
      entry.consumer = yield* Effect.forkIn(consume(sessionId, entry), rt.engineScope);

      return entry;
    });

  const consume = (sessionId: SessionId, entry: LiveHarness): Effect.Effect<void> =>
    entry.session.events.pipe(
      Stream.runForEach((event) =>
        observed(sessionId, entry, event).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(`handling ${event._tag} for ${sessionId} failed`, cause)
          )
        )
      ),
      // A stream that ends without `Exited` is a clean exit.
      Effect.andThen(
        Effect.suspend(() =>
          entry.stopping
            ? Effect.void
            : recorded(sessionId, entry, (at) => onExited(sessionId, entry, null, at)).pipe(
                Effect.catchCause((cause) => Effect.logError("handling exit failed", cause))
              )
        )
      )
    );

  const turnAliases = new HarnessTurnAliases<EventSource>();

  const isDelta = HarnessEvent.$is("ItemDelta");
  const endsTurn = HarnessEvent.$is("TurnEnded");
  const endsSubagent = HarnessEvent.$is("SubagentEnded");

  const onHarnessEvent = (
    sessionId: SessionId,
    entry: EventSource,
    event: HarnessEvent
  ): Effect.Effect<void, ServiceError> =>
    // Deltas are most of what a Harness emits: publish them without the rest.
    isDelta(event)
      ? Effect.suspend(() =>
          entry.stopping
            ? Effect.void
            : store.publishEphemeral(
                LiveItem.Delta({
                  sessionId,
                  turnId: event.turnId,
                  itemId: event.itemId,
                  field: event.field,
                  // Only a secret whole within one delta; the completed item is redacted in full.
                  text: redactText(event.text),
                  subagentId: event.subagentId ?? null,
                })
              )
        )
      : recorded(sessionId, entry, (at) => onHarnessRecord(sessionId, entry, event, at));

  const observed = (sessionId: SessionId, entry: EventSource, event: HarnessEvent) => {
    const canonical = turnAliases.resolve(entry, event);

    const activity = rt.touchIdle(sessionId);

    const processing = onHarnessEvent(sessionId, entry, canonical).pipe(
      Effect.andThen(liveness.observe(sessionId, canonical, Date.now()))
    );

    const completed =
      endsTurn(canonical) || endsSubagent(canonical)
        ? processing.pipe(Effect.tap(() => Effect.sync(() => turnAliases.ended(entry, canonical))))
        : processing;

    return activity === null ? completed : completed.pipe(Effect.andThen(activity));
  };

  /** Runs `handle` with the time, unless the source is being stopped on purpose. */
  const recorded = (
    sessionId: SessionId,
    entry: EventSource,
    handle: (at: string) => Effect.Effect<void, ServiceError>
  ) =>
    Effect.gen(function* () {
      if (entry.stopping) return;
      yield* handle(yield* rt.now);
    });

  const onHarnessRecord = (
    sessionId: SessionId,
    entry: EventSource,
    event: HarnessEvent,
    at: string
  ): Effect.Effect<void, ServiceError> =>
    HarnessEvent.$match(event, {
      CursorAssigned: (e) =>
        rt.recordFor(sessionId, (record) =>
          record.session.harnessCursor === e.cursor
            ? []
            : [
                DomainEvent.cases.SessionCursorUpdated.make({
                  sessionId,
                  harnessCursor: e.cursor,
                }),
              ]
        ),
      TurnStarted: (e) =>
        Effect.gen(function* () {
          const result = yield* rt.signal(sessionId, {
            type: "harness.turnStarted",
            turnId: e.turnId,
            prompt: e.prompt ?? "",
            trigger: e.trigger ?? null,
            at,
          });

          const record = "model" in result ? result.model.sessions.get(sessionId) : undefined;
          const working = record?.turns.find((turn) => turn.status === "working");
          // A user command committed before this queued native start: correlate the merged run.

          if (e.trigger != null && working !== undefined && working.id !== e.turnId) {
            turnAliases.set(entry, e.turnId, working.id);
          }

          yield* rt.cancelIdle(sessionId);
        }),
      ItemDelta: () => Effect.void, // handled by onHarnessEvent
      ItemUpdated: (e) => onItemUpdated(sessionId, e),
      ItemCompleted: (e) =>
        Effect.suspend(() => {
          progress.get(sessionId)?.delete(e.item.id);

          return rt.recordFor(sessionId, () => [
            DomainEvent.cases.TurnItemCompleted.make({
              sessionId,
              turnId: e.turnId,
              item: redact(e.item),
              subagentId: e.subagentId ?? null,
            }),
          ]);
        }),
      ApprovalRequested: (e) =>
        answeredByPolicy(sessionId, entry, e).pipe(
          Effect.flatMap((answered) =>
            answered
              ? Effect.void
              : rt.signal(sessionId, {
                  type: "harness.approvalRequested",
                  request: new ApprovalRequest({
                    id: e.requestId,
                    sessionId,
                    turnId: e.turnId,
                    kind: e.kind,
                    title: redactText(e.title),
                    detail: redactNullable(e.detail),
                    options: [...e.options],
                    questions: [...(e.questions ?? [])],
                    openedAt: at,
                  }),
                })
          )
        ),
      ApprovalWithdrawn: (e) =>
        rt.signal(sessionId, { type: "harness.approvalWithdrawn", requestId: e.requestId }),
      TurnEnded: (e) => onTurnEnded(sessionId, e, at),
      BackgroundTasksChanged: (e) =>
        rt.signal(sessionId, {
          type: "harness.backgroundTasksChanged",
          tasks: e.tasks,
          reportsPending: e.reportsPending ?? false,
        }),
      SubagentStarted: (e) =>
        rt.signal(sessionId, {
          type: "harness.subagentStarted",
          subagent: new Subagent({
            id: e.subagentId,
            sessionId,
            turnId: e.turnId,
            parentItemId: e.parentItemId,
            title: e.title,
            agent: e.agent,
            model: e.model,
            background: e.background ?? null,
            status: "working",
            startedAt: at,
            endedAt: null,
          }),
        }),
      SubagentEnded: (e) =>
        rt.signal(sessionId, {
          type: "harness.subagentEnded",
          subagentId: e.subagentId,
          status: e.status,
          report: e.report ?? null,
          at,
        }),
      TitleSuggested: (e) =>
        rt.recordFor(sessionId, (record) =>
          record.titleLocked || record.session.title === e.title
            ? []
            : [DomainEvent.cases.SessionRenamed.make({ sessionId, title: e.title })]
        ),
      ContextUsed: (e) =>
        rt.recordFor(sessionId, (record) => {
          const usage = contextUsageOf(e, record.session.contextUsage);

          const compacted =
            e.compacted === undefined
              ? []
              : [
                  DomainEvent.cases.SessionCompacted.make({
                    sessionId,
                    compaction: new Compaction({
                      turnId: workingTurn(record)?.id ?? null,
                      trigger: e.compacted.trigger,
                      beforeTokens: e.compacted.beforeTokens,
                      afterTokens: e.compacted.afterTokens,
                      at,
                    }),
                  }),
                ];

          return compacted.length > 0 || contextChanged(record.session.contextUsage, usage)
            ? [...compacted, DomainEvent.cases.SessionContextUsed.make({ sessionId, usage })]
            : [];
        }),
      WorktreeCreated: (e) => onWorktreeCreated(sessionId, e.path),
      Exited: (e) => onExited(sessionId, entry, e.error, at),
    }).pipe(Effect.asVoid);

  const onItemUpdated = (sessionId: SessionId, event: HarnessEventOf<"ItemUpdated">) =>
    Effect.suspend(() => {
      const items = progress.get(sessionId) ?? new Map<string, Progress>();
      const subagentId = event.subagentId ?? null;
      const item = redact(event.item);
      items.set(item.id, { turnId: event.turnId, item, subagentId });
      progress.set(sessionId, items);

      return store.publishEphemeral(
        LiveItem.ItemProgress({ sessionId, turnId: event.turnId, item, subagentId })
      );
    });

  /** A plain session's failed Turn at a usage limit; a worker's stays failed for the Lead. */
  const limitOf = (sessionId: SessionId, event: HarnessEventOf<"TurnEnded">, at: string) =>
    Effect.gen(function* () {
      if (event.status !== "failed") return null;
      const model = yield* store.model;
      const record = model.sessions.get(sessionId);

      if (record === undefined || isWorker(model, sessionId)) return null;

      return usageLimitOf({
        error: event.error,
        hint: event.limit,
        harness: record.session.harness,
        limits: Option.isSome(usage) ? yield* usage.value.planLimits : [],
        now: at,
      });
    });

  const onTurnEnded = (sessionId: SessionId, event: HarnessEventOf<"TurnEnded">, at: string) =>
    Effect.gen(function* () {
      rt.dropProgress(sessionId, event.turnId);
      const after = yield* rt.capture(sessionId, event.turnId, "after");
      yield* rt.signal(sessionId, {
        type: "harness.turnEnded",
        turnId: event.turnId,
        status: event.status,
        error: redactNullable(event.error),
        checkpoint: after,
        limit: yield* limitOf(sessionId, event, at),
        at,
      });
    });

  const onWorktreeCreated = (sessionId: SessionId, path: string) =>
    Effect.gen(function* () {
      const model = yield* store.model;
      const record = model.sessions.get(sessionId);
      const workspace = record && model.workspaces.get(record.session.workspaceId);

      if (workspace === undefined) return;

      const listed = yield* rt.worktrees
        .list(workspace.path)
        .pipe(Effect.catch(() => Effect.succeed([])));

      const info = listed.find((w) => w.path === path);
      yield* rt.recordFor(sessionId, () => [
        DomainEvent.cases.WorktreeDetected.make({
          worktree: new Worktree({
            id: worktreeIdFor(path),
            workspaceId: workspace.id,
            path,
            branch: info?.branch ?? null,
            head: info?.head ?? "",
            createdBySessionId: sessionId,
            isMain: info?.isMain ?? false,
          }),
        }),
      ]);
    });

  const onExited = (sessionId: SessionId, entry: EventSource, error: string | null, at: string) =>
    Effect.gen(function* () {
      entry.stopping = true;

      if (live.get(sessionId) === entry) live.delete(sessionId);
      rt.dropProgress(sessionId);
      yield* rt.cancelIdle(sessionId);
      yield* Scope.close(entry.scope, Exit.void);
      yield* rt.signal(sessionId, { type: "harness.exited", error, at });
    });

  const deliverTurn = (input: TurnToRun): Effect.Effect<boolean, ServiceError> =>
    Effect.suspend(() => {
      let refusalReported = false;

      return Effect.scoped(
        Effect.gen(function* () {
          const { sessionId, turnId, prompt, attachments } = input;
          const model = yield* store.model;
          const turn = model.sessions.get(sessionId)?.turns.find((t) => t.id === turnId);

          if (turn === undefined || turn.status !== "working") return false;

          if (turn.checkpointBefore === null) yield* recordBefore(sessionId, turnId);

          if (input.steerExisting === true) {
            const current = (yield* store.model).sessions
              .get(sessionId)
              ?.turns.find((t) => t.id === turnId);

            if (current?.status !== "working" || !live.has(sessionId)) return false;
          }

          yield* rt.cancelIdle(sessionId);
          // Before opening: a Harness may report its cursor as soon as it opens.
          const session = (yield* store.model).sessions.get(sessionId)?.session;

          const promptInput =
            session !== undefined &&
            session.parentSessionId !== null &&
            session.harnessCursor === null
              ? yield* withForkContext(session, session.parentSessionId, prompt)
              : prompt;

          const entry = yield* timedStart(
            openHarness(sessionId),
            session?.harness ?? "harness",
            rt.config.harnessStartTimeout ?? DEFAULT_HARNESS_START_TIMEOUT,
            shortHostName(),
            sessionId
          );

          yield* rt.signal(sessionId, { type: "harness.opened" });

          const turnInput = {
            turnId,
            prompt: promptInput,
            attachments,
            model: turn.model,
            effort: turn.effort,
            serviceTier: turn.serviceTier,
          };

          if (input.shellCommand != null) {
            yield* startShellTurn({ sessionId, command: input.shellCommand, turnInput });

            return true;
          }

          if (input.steerExisting === true)
            return yield* (entry.session.steerTurn?.(turnInput) ?? Effect.succeed(false)).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  refusalReported = error.recorded === true;
                })
              )
            );
          yield* entry.session.sendTurn(turnInput);

          return true;
        })
      ).pipe(
        Effect.catch((error) =>
          input.steerExisting === true
            ? (refusalReported ? Effect.void : refuseUserTurn(rt, input, error.message)).pipe(
                Effect.as(true)
              )
            : rt.failSession(input.sessionId, error.message).pipe(Effect.as(true))
        )
      );
    });

  const endInterrupted = (sessionId: SessionId, turnId: TurnId) =>
    Effect.flatMap(rt.now, (at) =>
      onTurnEnded(
        sessionId,
        HarnessEvent.TurnEnded({ turnId, status: "interrupted", error: null }),
        at
      )
    );

  // Loaded on a session's first shell command, so the Daemon's start-up never pays for it.
  const startShellTurn = (turn: ShellTurn) =>
    Effect.promise(() => import("./supervisor.shell.ts")).pipe(
      Effect.flatMap(({ shellTurns }) => shellTurns(rt, endInterrupted).start(turn))
    );

  const enqueue = deferredUserTurns(rt, deliverTurn);

  const runTurn = (input: TurnToRun): Effect.Effect<void, ServiceError> =>
    input.steerExisting === true ? enqueue(input) : deliverTurn(input).pipe(Effect.asVoid);

  const recordBefore = (sessionId: SessionId, turnId: TurnId) =>
    Effect.gen(function* () {
      const before = yield* rt.capture(sessionId, turnId, "before");

      if (before === null) return;
      yield* rt.recordFor(sessionId, () => [
        DomainEvent.cases.CheckpointRecorded.make({
          sessionId,
          turnId,
          ref: before.ref,
          commit: before.commit,
        }),
      ]);
    });

  /** A Fork's Harness starts fresh: prefix its first Turn with the parent's conversation (fork.ts). */
  const withForkContext = (session: AgentSession, parentId: SessionId, prompt: string) =>
    Effect.gen(function* () {
      const model = yield* store.model;
      const parent = model.sessions.get(parentId);
      const turns = yield* store.readTurns({ sessionId: parentId, beforeIndex: null, limit: null });
      const at = turns.findIndex((t) => t.id === session.forkedFromTurnId);
      const included = at === -1 ? turns : turns.slice(0, at + 1);

      const items = yield* store.readTurnItems({
        turnIds: included.map((t) => t.id),
        upTo: model.sequence,
      });

      return forkPreamble({
        parentTitle: parent?.session.title ?? parentId,
        ownWorktree:
          session.worktreeId !== null && session.worktreeId !== parent?.session.worktreeId,
        turns: included.map((t) => ({ prompt: t.prompt, reply: finalReply(items.get(t.id)) })),
        prompt,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.as(Effect.logWarning(`fork context for ${session.id}: ${error.message}`), prompt)
      )
    );

  return { openHarness, onHarnessEvent: observed, runTurn };
};

export class Supervisor extends Context.Service<
  Supervisor,
  {
    /** The session's running Harness, opened (resuming its cursor) if needed. */
    readonly openHarness: (
      sessionId: SessionId
    ) => Effect.Effect<LiveHarness, NotFound | ServiceError | HarnessError>;
    /** Handle one event a Harness or a followed terminal UI reported. */
    readonly onHarnessEvent: (
      sessionId: SessionId,
      entry: EventSource,
      event: HarnessEvent
    ) => Effect.Effect<void, ServiceError>;
    /** Capture the before-checkpoint, make sure the Harness runs, and hand it the Turn. */
    readonly runTurn: (turn: TurnToRun) => Effect.Effect<void, ServiceError>;
  }
>()("polaris/daemon/engine/Supervisor") {
  static readonly layer = Layer.effect(
    Supervisor,
    Effect.gen(function* () {
      return make(
        yield* EngineRuntime,
        yield* Effect.serviceOption(ApprovalPolicy),
        yield* ConstellationHarness,
        yield* ConstellationLiveness,
        yield* Effect.serviceOption(UsageIndex),
        yield* SecretRequests
      );
    })
  );
}
