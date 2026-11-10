/**
 * A fake Host for thread tests: the real effect/rpc client over in-memory
 * handlers for just the RPCs the thread calls. It numbers drafts and keeps
 * read positions like the Daemon (F3), records dispatched commands, and
 * answers cached Risk Summaries by head. It has no `review.runRiskSummary`.
 */
import type { LiveSource } from "@polaris/client/resume";
import {
  AgentSession,
  CommandRejected,
  ApprovalRequest,
  type CommandId,
  RequestId,
  type Command,
  ComposerDraft,
  ContinuityItem,
  DomainEvent,
  EventEnvelope,
  LineRange,
  ReadPosition,
  RiskFinding,
  RiskFindingId,
  LayerRun,
  ReviewSubject,
  RiskSummary,
  RiskSummaryId,
  RiskSummaryKey,
  RiskSummaryLayers,
  RiskSummaryRef,
  SecretRejected,
  type SecretRejectedReason,
  Sequence,
  SessionId,
  SessionStreamItem,
  Turn,
  TurnDetail,
  TurnPage,
  TurnId,
  type TurnItem,
  Unsupported,
  HostStreamItem,
  Workspace,
  UserAccessGate,
  WorkspaceId,
} from "@polaris/protocol";
import { Deferred, Effect, Layer, PubSub, Queue, Redacted, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import { type ThreadClient, ThreadRpcs } from "./source.ts";

export const at = "2026-10-27T12:00:00.000Z";

export const sessionId = SessionId.make("s-1");

export const workspaceId = WorkspaceId.make("w-1");

export const session = (fields: Partial<AgentSession> = {}) =>
  new AgentSession({
    id: sessionId,
    workspaceId,
    harness: "claude",
    title: "Polaris planning",
    cwd: "/repo",
    worktreeId: null,
    state: "idle",
    permissionMode: "supervised",
    model: null,
    effort: null,
    parentSessionId: null,
    forkedFromTurnId: null,
    harnessCursor: null,
    turnCount: 0,
    contextUsage: null,
    lastError: null,
    createdAt: at,
    updatedAt: at,
    ...fields,
  });

export const turn = (index: number, fields: Partial<Turn> = {}) =>
  new Turn({
    id: TurnId.make(`t-${index}`),
    sessionId,
    index,
    prompt: `prompt ${index}`,
    attachments: [],
    model: null,
    effort: null,
    status: "completed",
    checkpointBefore: null,
    checkpointAfter: null,
    startedAt: at,
    endedAt: at,
    ...fields,
  });

export const request = (fields: Partial<ApprovalRequest> = {}) =>
  new ApprovalRequest({
    id: RequestId.make("r-1"),
    sessionId,
    turnId: TurnId.make("t-1"),
    kind: "command",
    title: "Run a command",
    detail: null,
    options: [],
    questions: [],
    openedAt: at,
    ...fields,
  });

export const snapshot = (
  turns: ReadonlyArray<{ readonly turn: Turn; readonly items?: ReadonlyArray<TurnItem> }>,
  fields: Partial<AgentSession> = {},
  pendingApprovals: ReadonlyArray<ApprovalRequest> = []
) =>
  SessionStreamItem.cases.Snapshot.make({
    sequence: Sequence.make(1),
    session: session({ turnCount: turns.length, ...fields }),
    turns: turns.map(
      (entry) => new TurnDetail({ turn: entry.turn, items: entry.items ?? [], subagents: [] })
    ),
    pendingApprovals,
  });

export const event = (sequence: number, domain: DomainEvent) =>
  SessionStreamItem.cases.Event.make({
    envelope: new EventEnvelope({
      sequence: Sequence.make(sequence),
      occurredAt: at,
      commandId: null,
      event: domain,
    }),
  });

export const finding = (fields: Partial<RiskFinding> = {}) =>
  new RiskFinding({
    id: RiskFindingId.make("f-1"),
    identity: "id-1",
    source: "rule",
    ruleId: "secret-like-value",
    path: "serve.ts",
    lines: new LineRange({ start: 4, end: 4, side: "new" }),
    severity: "critical",
    confidence: 1,
    title: "Secret-like value committed",
    reason: "A token in source",
    suggestion: null,
    status: "open",
    resolution: null,
    ...fields,
  });

/** A finished, rules-only session summary covering Turns through `head`. */
export const summaryAt = (head: string, findings: ReadonlyArray<RiskFinding>) =>
  new RiskSummary({
    id: RiskSummaryId.make(`sum-${head}`),
    key: new RiskSummaryKey({ repo: "/repo", mergeBase: "m0", head, since: null }),
    workspaceId,
    subject: ReviewSubject.cases.SessionTurns.make({
      sessionId,
      firstTurnId: null,
      lastTurnId: null,
    }),
    checkoutId: null,
    status: "completed",
    layers: new RiskSummaryLayers({
      rules: new LayerRun({ status: "completed", note: null }),
      agent: new LayerRun({ status: "skipped", note: null }),
    }),
    reviewer: null,
    cost: null,
    note: null,
    findings,
    startedAt: at,
    endedAt: at,
  });

export interface FakeHost {
  readonly live: LiveSource<ThreadClient>;
  /** Sends an item down the session's feed. */
  readonly push: (item: SessionStreamItem) => Effect.Effect<void>;
  /** Another Client saves a draft. */
  readonly saveElsewhere: (text: string) => Effect.Effect<void>;
  readonly commands: ReadonlyArray<Command>;
  /** The id each dispatch carried, as the Host received it. */
  readonly commandIds: ReadonlyArray<CommandId>;
  /** Every draft the Host stored, oldest first. */
  readonly saved: ReadonlyArray<string>;
  /** Holds dispatch answers until `releaseDispatches`. */
  readonly holdDispatches: () => void;
  readonly releaseDispatches: () => Effect.Effect<void>;
  /** The next dispatch is applied but its answer is lost with the connection. */
  readonly dropNextAnswer: () => void;
  /** The next dispatch is refused by the Host with `reason`. */
  readonly refuseNext: (reason: string) => void;
  /** The connection drops: calls wait for the next one, as on a reconnecting Host. */
  readonly goAway: () => void;
  /** The next connection is up; calls that waited go on it. */
  readonly comeBack: () => Effect.Effect<void>;
  readonly reads: ReadonlyArray<number>;
  readonly summariesAsked: ReadonlyArray<string>;
  /** Each `session.turns` call's `beforeIndex`, in order. */
  readonly pagesAsked: ReadonlyArray<number>;
  /** Holds saveDraft's answers until `release` (the phone waits for the Host's ack). */
  readonly holdSaves: () => void;
  /** The next saveDraft fails, as when the connection drops mid-write. */
  readonly failNextSave: () => void;
  /** Each `secret.provide` the Host accepted: the request and the value it would write. */
  readonly secrets: ReadonlyArray<{ readonly requestId: RequestId; readonly value: string }>;
  /** The next `secret.provide` is refused with `SecretRejected`. */
  readonly rejectNextSecret: (reason: SecretRejectedReason, message: string) => void;
  readonly release: () => Effect.Effect<void>;
}

export interface FakeHostOptions {
  /** Cached Risk Summaries by the head commit they cover. */
  readonly summaries?: ReadonlyMap<string, RiskSummary>;
  /** The session's whole history, oldest first, as `session.turns` pages it. */
  readonly history?: ReadonlyArray<Turn>;
  /** The Workspace's name in the Host's Snapshot; "polaris" by default. */
  readonly workspaceName?: string;
}

export const makeFakeHost = Effect.fnUntraced(function* (options: FakeHostOptions = {}) {
  const feed = yield* Queue.unbounded<SessionStreamItem>();
  const changes = yield* PubSub.unbounded<ContinuityItem>();
  const commands: Array<Command> = [];
  const commandIds: Array<CommandId> = [];
  const saved: Array<string> = [];
  let dispatchGate: Deferred.Deferred<void> | null = null;
  let dropNext = false;
  let refusal: string | null = null;
  let back: Deferred.Deferred<void> | null = null;
  let epoch = 1;
  const reads: Array<number> = [];
  const summariesAsked: Array<string> = [];
  const pagesAsked: Array<number> = [];
  const secrets: Array<{ readonly requestId: RequestId; readonly value: string }> = [];
  let secretRefusal: SecretRejected | null = null;
  const drafts = new Map<SessionId, ComposerDraft>();
  let readPosition: ReadPosition | null = null;
  let revision = 0;
  let gate: Deferred.Deferred<void> | null = null;
  let failNext = false;

  const save = (text: string) => {
    revision++;
    saved.push(text);
    const draft = new ComposerDraft({ sessionId, text, revision, at });
    drafts.set(sessionId, draft);

    return Effect.as(PubSub.publish(changes, ContinuityItem.cases.Draft.make({ draft })), draft);
  };

  const handlers = ThreadRpcs.toLayer({
    subscribeHost: () =>
      Stream.make(
        HostStreamItem.cases.Snapshot.make({
          sequence: Sequence.make(1),
          workspaces: [
            new Workspace({
              id: workspaceId,
              path: "/repo",
              name: options.workspaceName ?? "polaris",
              isGitRepo: true,
              worktreeRoot: "/repo.worktrees",
              hidden: false,
              registeredAt: at,
            }),
          ],
          worktrees: [],
          sessions: [],
        })
      ),
    subscribeSession: () => Stream.fromQueue(feed),
    dispatch: ({ command, commandId }) => {
      const reason = refusal;
      refusal = null;

      if (reason !== null) return Effect.fail(new CommandRejected({ commandId, reason }));

      return Effect.flatMap(
        dispatchGate === null ? Effect.void : Deferred.await(dispatchGate),
        () =>
          Effect.sync(() => {
            commands.push(command);
            commandIds.push(commandId);

            return { sequence: null };
          })
      );
    },
    "continuity.watch": () =>
      Stream.concat(
        Stream.make(
          ContinuityItem.cases.Snapshot.make({
            reads: readPosition === null ? [] : [readPosition],
            drafts: [...drafts.values()],
          })
        ),
        Stream.fromPubSub(changes)
      ),
    "continuity.markRead": ({ turnId }) =>
      Effect.sync(() => {
        const index = Number(turnId.slice(2));
        reads.push(index);

        if (readPosition === null || readPosition.turnIndex < index)
          readPosition = new ReadPosition({ sessionId, turnId, turnIndex: index, at });

        return readPosition;
      }),
    "continuity.saveDraft": ({ text }) => {
      if (failNext) {
        failNext = false;

        return Effect.fail(new Unsupported({ capability: "session.continuity" }));
      }

      return Effect.flatMap(gate === null ? Effect.void : Deferred.await(gate), () => save(text));
    },
    "review.riskSummary": ({ ref }) =>
      Effect.sync(() =>
        RiskSummaryRef.match(ref, {
          LatestAt: ({ head }) => {
            summariesAsked.push(head);

            return options.summaries?.get(head) ?? null;
          },
          ById: () => null,
          ByKey: () => null,
        })
      ),
    "session.turns": ({ beforeIndex, limit }) =>
      Effect.sync(() => {
        const before = (options.history ?? []).filter((t) => t.index < beforeIndex);
        const page = before.slice(Math.max(0, before.length - limit));

        pagesAsked.push(beforeIndex);

        return new TurnPage({
          turns: page.map((t) => new TurnDetail({ turn: t, items: [], subagents: [] })),
          sequence: Sequence.make(1),
          hasMore: page.length < before.length,
        });
      }),
    "secret.provide": ({ requestId, value }) => {
      const refused = secretRefusal;
      secretRefusal = null;

      if (refused !== null) return Effect.fail(refused);

      return Effect.sync(() => {
        secrets.push({ requestId, value: Redacted.value(value) });
      });
    },
    "review.watchRiskSummary": ({ summaryId }) =>
      Stream.fromIterable(
        [...(options.summaries?.values() ?? [])].filter((summary) => summary.id === summaryId)
      ),
  });

  const client = yield* RpcTest.makeClient(ThreadRpcs).pipe(
    // The fake Host's user is the app's: its gate lets everything through.
    Effect.provide(
      Layer.merge(
        handlers,
        Layer.succeed(UserAccessGate, (effect) => effect)
      )
    )
  );

  const lossy: ThreadClient = {
    ...client,
    // SAFETY: the same call with one more failure, RpcClientError, which dispatch already declares.
    dispatch: ((payload: Parameters<ThreadClient["dispatch"]>[0]) => {
      if (!dropNext) return client.dispatch(payload);
      dropNext = false;

      const lost = new RpcClientError({
        reason: new RpcClientDefect({ message: "connection lost", cause: null }),
      });

      return Effect.flatMap(client.dispatch(payload), () => Effect.fail(lost));
    }) as ThreadClient["dispatch"],
  };

  const host: FakeHost = {
    live: {
      next: () =>
        Effect.suspend(() =>
          Effect.as(back === null ? Effect.void : Deferred.await(back), { epoch, client: lossy })
        ),
    },
    push: (item) => Effect.asVoid(Queue.offer(feed, item)),
    saveElsewhere: (text) => Effect.asVoid(save(text)),
    commands,
    commandIds,
    saved,
    holdDispatches: () => {
      dispatchGate = Deferred.makeUnsafe<void>();
    },
    releaseDispatches: () =>
      dispatchGate === null
        ? Effect.void
        : Effect.asVoid(Deferred.succeed(dispatchGate, undefined)),
    dropNextAnswer: () => {
      dropNext = true;
    },
    refuseNext: (reason) => {
      refusal = reason;
    },
    goAway: () => {
      back ??= Deferred.makeUnsafe<void>();
    },
    comeBack: () =>
      Effect.suspend(() => {
        const waiting = back;
        back = null;
        epoch++;

        return waiting === null ? Effect.void : Effect.asVoid(Deferred.succeed(waiting, undefined));
      }),
    reads,
    summariesAsked,
    pagesAsked,
    failNextSave: () => {
      failNext = true;
    },
    secrets,
    rejectNextSecret: (reason, message) => {
      secretRefusal = new SecretRejected({ reason, message });
    },
    holdSaves: () => {
      gate = Deferred.makeUnsafe<void>();
    },
    release: () => (gate === null ? Effect.void : Effect.asVoid(Deferred.succeed(gate, undefined))),
  };

  return host;
});

export const ended = (sequence: number, done: Turn) =>
  event(sequence, DomainEvent.cases.TurnEnded.make({ turn: done }));

export const started = (sequence: number, begun: Turn) =>
  event(sequence, DomainEvent.cases.TurnStarted.make({ turn: begun }));

export const stateChanged = (sequence: number, state: "working" | "idle") =>
  event(
    sequence,
    DomainEvent.cases.SessionStateChanged.make({ sessionId, state, reason: null, resetsAt: null })
  );

export const checkpoint = (sequence: number, turnIndex: number, ref: string, commit: string) =>
  event(
    sequence,
    DomainEvent.cases.CheckpointRecorded.make({
      sessionId,
      turnId: TurnId.make(`t-${turnIndex}`),
      ref,
      commit,
    })
  );
