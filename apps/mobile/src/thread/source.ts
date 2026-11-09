/**
 * What the thread needs from one Host, as a port: the session's feed, its
 * commands, continuity (read position and draft) and the session's Risk
 * Summary findings. `daemonThreadSource` backs it with the Host's live
 * `DaemonClient` (a `ThreadClient`); tests pass one over in-memory handlers.
 */
import {
  type Command,
  CommandId,
  type ComposerDraft,
  ContinuityItem,
  Dispatch,
  GetRiskSummary,
  MarkRead,
  ProvideSecret,
  ReadTurns,
  type RequestId,
  SaveDraft,
  HostStreamItem,
  type Sequence,
  SessionStreamItem,
  SubscribeHost,
  SubscribeSession,
  WatchContinuity,
  type Workspace,
  WatchRiskSummary,
  type ReadPosition,
  type RiskFinding,
  type RiskSummaryId,
  type SessionId,
  type TurnId,
  type TurnPage,
  type WorkspaceId,
  RiskSummaryRef,
  gateUserRpcs,
} from "@polaris/protocol";
import { type LiveSource, makeFeed, type SequenceMark } from "@polaris/client/resume";
import { Data, Effect, Option, Predicate, type Redacted, Stream } from "effect";
import { type RpcClient, RpcGroup } from "effect/rpc";
import { tracedDispatch } from "../selfTraces/index.ts";
import type { RpcClientError } from "effect/rpc/RpcClientError";

/** Why a call or feed failed, as the user reads it. */
export class ThreadFailure extends Data.TaggedError("ThreadFailure")<{
  readonly message: string;
  /** The connection dropped mid-call: the Host may have applied it. */
  readonly ambiguous?: boolean;
}> {}

export interface ThreadSource {
  /** The session's feed across reconnects: a Snapshot first, then its changes. */
  readonly session: (sessionId: SessionId) => Stream.Stream<SessionStreamItem, ThreadFailure>;
  /** A retry passes the same `commandId`, so the Host applies the command once. */
  readonly dispatch: (command: Command, commandId: CommandId) => Effect.Effect<void, ThreadFailure>;
  /** Saves a Secret Request's value on the Host (ADR 0089); a refusal carries the Host's words. */
  readonly provideSecret: (
    sessionId: SessionId,
    requestId: RequestId,
    value: Redacted.Redacted<string>
  ) => Effect.Effect<void, ThreadFailure>;
  /** Every session's read position and draft; ends at once on a Host without continuity. */
  readonly continuity: Stream.Stream<ContinuityItem, ThreadFailure>;
  readonly markRead: (
    sessionId: SessionId,
    turnId: TurnId
  ) => Effect.Effect<ReadPosition, ThreadFailure>;
  readonly saveDraft: (
    sessionId: SessionId,
    text: string
  ) => Effect.Effect<ComposerDraft, ThreadFailure>;
  /**
   * The session's cached Risk Summary findings as they change; ends with none
   * when no summary exists. Never starts a review.
   */
  readonly findings: (
    query: FindingsQuery
  ) => Stream.Stream<ReadonlyArray<RiskFinding>, ThreadFailure>;
  /** A Workspace's name and path on the Host, read once from the Host's Snapshot. */
  readonly workspace: (workspaceId: WorkspaceId) => Effect.Effect<Workspace | null, ThreadFailure>;
  /** The Daemon has `session.steer`. */
  readonly canSteer: boolean;
  /** Up to `limit` Turns before `beforeIndex`; null on a Host that can't page them to a phone. */
  readonly olderTurns: (
    sessionId: SessionId,
    beforeIndex: number,
    limit: number
  ) => Effect.Effect<TurnPage | null, ThreadFailure>;
}

export interface FindingsQuery {
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  /** The last ended Turn's after-checkpoint commit, when known (`summaryHead`). */
  readonly head: string | null;
}

/** How many Turns the first Snapshot holds; scrolling up pages in the earlier ones. */
export const TURN_LIMIT = 30;

/** What every Daemon and transport error carries. */
interface Failed {
  readonly _tag: string;
  readonly message: string;
  /** A refused command's own words on `CommandRejected`; other errors carry other reasons. */
  readonly reason?: unknown;
}

/** What the Host said when it refused a command, if it did. */
const refusal = (error: Failed): string | null =>
  Predicate.isTagged(error, "CommandRejected") && Predicate.isString(error.reason)
    ? error.reason
    : null;

const isDisconnect = (error: Failed) => Predicate.isTagged(error, "RpcClientError");

const failure = (error: Failed) =>
  new ThreadFailure({
    message: refusal(error) ?? (error.message === "" ? error._tag : error.message),
    ambiguous: isDisconnect(error),
  });

let commandCount = 0;

/** Client-generated, so a retried dispatch is applied once. */
export const newCommandId = (): CommandId => {
  commandCount++;

  return CommandId.make(
    `mobile-${Date.now().toString(36)}-${commandCount}-${Math.random().toString(36).slice(2, 8)}`
  );
};

/** The RPCs the thread calls, behind the user gate as on `DaemonRpcs`; a full `DaemonClient` is one of these. */
export const ThreadRpcs = gateUserRpcs(
  RpcGroup.make(
    SubscribeHost,
    SubscribeSession,
    Dispatch,
    WatchContinuity,
    MarkRead,
    SaveDraft,
    GetRiskSummary,
    WatchRiskSummary,
    ReadTurns,
    ProvideSecret
  )
);

export type ThreadClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ThreadRpcs>, RpcClientError>;

const markSession = SessionStreamItem.match<SequenceMark>({
  Snapshot: (item) => ({ kind: "snapshot", sequence: item.sequence }),
  Event: (item) => ({ kind: "event", sequence: item.envelope.sequence }),
  Synchronized: (item) => ({ kind: "synchronized", sequence: item.sequence }),
  Delta: () => ({ kind: "ephemeral" }),
  ItemProgress: () => ({ kind: "ephemeral" }),
});

/** A reopened watch starts with a fresh Snapshot, which replaces everything. */
const markContinuity = ContinuityItem.match<SequenceMark>({
  Snapshot: () => ({ kind: "snapshot", sequence: 0 }),
  Read: () => ({ kind: "ephemeral" }),
  Draft: () => ({ kind: "ephemeral" }),
});

export interface DaemonThreadOptions {
  readonly live: LiveSource<ThreadClient>;
  readonly capabilities: ReadonlySet<string>;
}

/** The latest connection's client, waiting for one while the Host reconnects. */
const withClient = <A, E extends Failed>(
  live: LiveSource<ThreadClient>,
  use: (client: ThreadClient) => Effect.Effect<A, E>
) => Effect.flatMap(live.next(0), ({ client }) => use(client)).pipe(Effect.mapError(failure));

/** The Host's Workspaces from its Snapshot, the first item of its stream. */
const readWorkspaces = (client: ThreadClient) =>
  client.subscribeHost({ afterSequence: null }).pipe(
    Stream.runHead,
    Effect.map((first) =>
      Option.match(first, {
        onNone: (): ReadonlyArray<Workspace> => [],
        onSome: (item) =>
          HostStreamItem.match(item, {
            Snapshot: (snap): ReadonlyArray<Workspace> => snap.workspaces,
            Event: (): ReadonlyArray<Workspace> => [],
            Synchronized: (): ReadonlyArray<Workspace> => [],
          }),
      })
    )
  );

/** The summary already on the Host for the query's head. */
const cachedSummary = (
  client: ThreadClient,
  query: FindingsQuery,
  repo: string | null
): Effect.Effect<RiskSummaryId | null, Failed> => {
  if (query.head === null || repo === null) return Effect.succeed(null);

  return Effect.map(
    client["review.riskSummary"]({
      ref: RiskSummaryRef.cases.LatestAt.make({ repo, head: query.head }),
    }),
    (summary) => summary?.id ?? null
  );
};

export const daemonThreadSource = (options: DaemonThreadOptions): ThreadSource => {
  const { live, capabilities } = options;
  const has = (capability: string) => capabilities.has(capability);
  let workspaces: Promise<ReadonlyArray<Workspace>> | null = null;

  const workspace = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      workspaces ??= Effect.runPromise(withClient(live, readWorkspaces)).catch((error) => {
        workspaces = null;
        throw error;
      });

      const all = yield* Effect.tryPromise({
        try: () => workspaces ?? Promise.resolve([]),
        catch: () => new ThreadFailure({ message: "The host's workspaces didn't load" }),
      });

      return all.find((w) => w.id === workspaceId) ?? null;
    });

  return {
    workspace,
    canSteer: has("session.steer"),
    olderTurns: (sessionId, beforeIndex, limit) =>
      has("session.turn-paging")
        ? withClient(live, (client) => client["session.turns"]({ sessionId, beforeIndex, limit }))
        : Effect.succeed(null),
    session: (sessionId) =>
      Stream.unwrap(
        Effect.map(
          makeFeed<ThreadClient, SessionStreamItem, Failed>({
            source: live,
            open: (client, afterSequence) =>
              client.subscribeSession({
                sessionId,
                // SAFETY: the feed passes back a sequence the Daemon itself sent.
                afterSequence: afterSequence === null ? null : (afterSequence as Sequence),
                turnLimit: TURN_LIMIT,
              }),
            mark: markSession,
            isDisconnect,
            gapless: false,
          }),
          (feed) => feed.stream
        )
      ).pipe(Stream.mapError(failure)),
    dispatch: (command, commandId) =>
      withClient(live, (client) =>
        tracedDispatch(command, commandId, Effect.asVoid(client.dispatch({ commandId, command })))
      ),
    provideSecret: (sessionId, requestId, value) =>
      withClient(live, (client) => client["secret.provide"]({ sessionId, requestId, value })),
    continuity: has("session.continuity")
      ? Stream.unwrap(
          Effect.map(
            makeFeed<ThreadClient, ContinuityItem, Failed>({
              source: live,
              open: (client) => client["continuity.watch"]({}),
              mark: markContinuity,
              isDisconnect,
              gapless: false,
            }),
            (feed) => feed.stream
          )
        ).pipe(Stream.mapError(failure))
      : Stream.empty,
    markRead: (sessionId, turnId) =>
      withClient(live, (client) => client["continuity.markRead"]({ sessionId, turnId })),
    saveDraft: (sessionId, text) =>
      withClient(live, (client) => client["continuity.saveDraft"]({ sessionId, text })),
    findings: (query) =>
      has("review.risk-summary")
        ? Stream.unwrap(
            Effect.flatMap(workspace(query.workspaceId), (found) =>
              withClient(live, (client) =>
                Effect.map(cachedSummary(client, query, found?.path ?? null), (summaryId) =>
                  summaryId === null
                    ? Stream.empty
                    : client["review.watchRiskSummary"]({ summaryId }).pipe(
                        Stream.map((summary) => summary.findings)
                      )
                )
              )
            )
          ).pipe(Stream.mapError(failure))
        : Stream.empty,
  };
};
