/**
 * The SDK's Effect API: a client over the Hosts its pairing strings name.
 * `openPolaris` needs a Scope; closing it closes every connection. The plain
 * Promise API (`promise.ts`) wraps this one.
 */
import {
  ApprovalDecision,
  Command,
  CommandId,
  type CommandRejected,
  ModelId,
  type NotFound,
  type NotGranted,
  type HarnessKind,
  type HostInfo,
  type PermissionMode,
  permissionModeFor,
  RequestId,
  SessionId,
  SessionPlacement,
  WorkspaceId,
} from "@polaris/protocol";
import { Duration, Effect, Match, Predicate, type Scope, Stream } from "effect";
import type { ConnectError, OpenTransport } from "./connection.ts";
import { UnknownHost } from "./errors.ts";
import { applyHostItem, emptyHostState, hostView, type HostView } from "./hostView.ts";
import {
  delayFor,
  type HostEntry,
  type HostLink,
  openLink,
  type Reconnect,
  resilientFeed,
} from "./link.ts";
import { decodePairing, type InvalidPairing, type ParsedPairing } from "./pairing.ts";
import { applySessionItem, sessionView, type SessionView } from "./sessionView.ts";
import { SDK_VERSION } from "./version.ts";
import { type TranscribeError, type Transcript, transcribeOn } from "./voice.ts";

export interface PolarisOptions {
  /** Pairing strings (`polaris-pair:v1:…`) or parsed ones; several may name the same Host. */
  readonly pairings: ReadonlyArray<string | ParsedPairing>;
  /** The Extension's name, e.g. "Raycast", sent in `hello`. */
  readonly clientName: string;
  readonly clientVersion?: string;
  /** Feeds reconnect after a lost connection unless false. */
  readonly reconnect?: boolean;
  /** The longest wait between reconnection attempts (default 10 s). */
  readonly maxReconnectDelay?: Duration.Input;
  /**
   * Receive computer use approvals (`app`, `headed-input`). Answer them with allow or deny
   * only: `alwaysAllowable` says when `remember` is refused (default false).
   */
  readonly computerUse?: boolean;
}

/** How to answer an approval. */
export type ApprovalResponse =
  | { readonly kind: "allow"; readonly remember?: boolean }
  | { readonly kind: "deny"; readonly reason?: string }
  | { readonly kind: "answer"; readonly text: string };

export interface StartSessionInput {
  readonly workspaceId: string;
  readonly harness: HarnessKind;
  readonly prompt: string;
  /**
   * Default `supervised`: anything but `plan` also needs the `approve` Grant. `plan` becomes `supervised`
   * on a Daemon without `session.plan-mode` (`HostView.capabilities`).
   */
  readonly permissionMode?: PermissionMode;
  /** Work in a new Worktree on this branch instead of the Workspace itself. */
  readonly worktree?: { readonly branch: string; readonly baseRef?: string };
  /** A Model id from the Harness, or the default when absent. */
  readonly model?: string;
}

export interface SubscribeSessionOptions {
  /** Only the latest N Turns in the first view (default 20). */
  readonly turnLimit?: number;
}

/** Errors any call on a Host can fail with, besides the RPC's own. */
export type HostError = ConnectError | UnknownHost;

/** What a `dispatch`, or a feed, can fail with. */
export type DispatchError = HostError | NotGranted | CommandRejected | NotFound;

export interface Polaris {
  /** Every Host the pairings name, once each, in pairing order. */
  readonly hosts: ReadonlyArray<HostEntry>;
  /** Connects to a Host (if not yet connected) and returns what its Daemon says about itself. */
  readonly connect: (hostId: string) => Effect.Effect<HostInfo, HostError>;
  /** A Host's Workspaces, sessions and pending approvals, re-emitted on every change. */
  readonly subscribeHost: (hostId: string) => Stream.Stream<HostView, DispatchError>;
  /**
   * Every Host at once: the latest view of each, re-emitted when any changes.
   * A Host that can't be reached shows as disconnected with `error` set; one that was never
   * reached is retried with backoff, unlike `subscribeHost`, which fails at once.
   */
  readonly subscribeHosts: () => Stream.Stream<ReadonlyArray<HostView>>;
  /** One session's Turns, items, approvals and streaming text. */
  readonly subscribeSession: (
    hostId: string,
    sessionId: string,
    options?: SubscribeSessionOptions
  ) => Stream.Stream<SessionView, DispatchError>;
  readonly sendTurn: (
    hostId: string,
    sessionId: string,
    prompt: string
  ) => Effect.Effect<void, DispatchError>;
  readonly respondToApproval: (
    hostId: string,
    sessionId: string,
    requestId: string,
    response: ApprovalResponse
  ) => Effect.Effect<void, DispatchError>;
  readonly interrupt: (hostId: string, sessionId: string) => Effect.Effect<void, DispatchError>;
  /** Continues a Turn the Daemon interrupted when it restarted. */
  readonly continue: (hostId: string, sessionId: string) => Effect.Effect<void, DispatchError>;
  /** Starts an Agent Session; resolves with its id once the Daemon recorded it. */
  readonly startSession: (
    hostId: string,
    input: StartSessionInput
  ) => Effect.Effect<string, DispatchError>;
  /**
   * Speech to text through the Host (the `voice` Grant): `audio` is 16 kHz signed 16-bit
   * little-endian mono PCM in chunks of any size. Each snapshot replaces the last; ending
   * `audio` ends the stream with a `finished` one, and ending the stream early stops it.
   */
  readonly transcribe: <E>(
    hostId: string,
    audio: Stream.Stream<Uint8Array, E>
  ) => Stream.Stream<Transcript, TranscribeError | UnknownHost>;
}

/** A random id, from `getRandomValues` (also in WebViews that are not a secure context). */
export const randomId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

/** Several pairings may name one Host (its socket and its gateway): one entry, tried in order. */
export const mergeHosts = (pairings: ReadonlyArray<ParsedPairing>): ReadonlyArray<HostEntry> => {
  const byHost = new Map<string, HostEntry>();

  for (const pairing of pairings) {
    const known = byHost.get(pairing.hostId);

    byHost.set(pairing.hostId, {
      hostId: pairing.hostId,
      hostName: known?.hostName ?? pairing.hostName,
      pairings: [...(known?.pairings ?? []), pairing],
    });
  }

  return [...byHost.values()];
};

const decisionOf = (response: ApprovalResponse): ApprovalDecision =>
  Match.value(response).pipe(
    Match.discriminatorsExhaustive("kind")({
      allow: ({ remember }) => ApprovalDecision.cases.Allow.make({ remember: remember ?? false }),
      deny: ({ reason }) => ApprovalDecision.cases.Deny.make({ reason: reason ?? null }),
      answer: ({ text }) => ApprovalDecision.cases.Answer.make({ text }),
    })
  );

const disconnected = (entry: HostEntry, error: Error): HostView => ({
  hostId: entry.hostId,
  hostName: entry.hostName,
  connected: false,
  error,
  capabilities: [],
  workspaces: [],
  sessions: [],
  archived: [],
  approvals: [],
});

export const openPolaris = Effect.fn("openPolaris")(function* (
  options: PolarisOptions,
  openTransport: OpenTransport
): Effect.fn.Return<Polaris, InvalidPairing, Scope.Scope> {
  const pairings = yield* Effect.forEach(options.pairings, (pairing) =>
    Predicate.isString(pairing) ? decodePairing(pairing) : Effect.succeed(pairing)
  );

  const hosts = mergeHosts(pairings);

  const connectOptions = {
    clientName: options.clientName,
    clientVersion: options.clientVersion ?? SDK_VERSION,
    openTransport,
    computerUse: options.computerUse ?? false,
  };

  const links = new Map<string, HostLink>();

  for (const entry of hosts) links.set(entry.hostId, yield* openLink(entry, connectOptions));
  yield* Effect.addFinalizer(() => Effect.forEach(links.values(), (link) => link.close));

  const reconnect: Reconnect = {
    enabled: options.reconnect ?? true,
    maxDelay: Duration.fromInputUnsafe(options.maxReconnectDelay ?? Duration.seconds(10)),
  };

  const linkOf = (hostId: string): Effect.Effect<HostLink, UnknownHost> => {
    const link = links.get(hostId);

    return link === undefined ? Effect.fail(new UnknownHost({ hostId })) : Effect.succeed(link);
  };

  const dispatch = (hostId: string, command: Command) =>
    Effect.flatMap(linkOf(hostId), (link) => {
      const commandId = CommandId.make(randomId());

      // A retried commandId is applied once, so a dispatch lost with its connection is resent.
      return link
        .call((client) => client.dispatch({ commandId, command }))
        .pipe(
          // A Pairing's token keeps an Extension out of the user gate (ADR 0100): never refused.
          Effect.catchTag("UserAccessRequired", (refused) => Effect.die(refused)),
          Effect.retry({
            times: 1,
            while: (error) => Predicate.isTagged(error, "HostUnreachable"),
          })
        );
    });

  const onSession = (hostId: string, sessionId: string, command: (id: SessionId) => Command) =>
    Effect.asVoid(dispatch(hostId, command(SessionId.make(sessionId))));

  const subscribeHost = (hostId: string) =>
    Stream.unwrap(
      Effect.map(linkOf(hostId), (link) =>
        resilientFeed(
          link,
          {
            initial: emptyHostState,
            open: (client, state) =>
              client.subscribeHost({
                afterSequence: state.synchronized ? state.sequence : null,
              }),
            apply: applyHostItem,
            view: (state, connected, capabilities) =>
              state.synchronized ? hostView(state, link.entry, connected, capabilities) : null,
          },
          reconnect
        )
      )
    );

  /** `subscribeHost` for `subscribeHosts`: a Host not reached yet shows disconnected and is retried. */
  const watchHost = (entry: HostEntry): Stream.Stream<HostView> => {
    let attempt = 0;

    const loop = (): Stream.Stream<HostView> =>
      subscribeHost(entry.hostId).pipe(
        Stream.catchTag("HostUnreachable", (error) => {
          const view = Stream.make(disconnected(entry, error));

          if (!reconnect.enabled) return view;
          const wait = delayFor(attempt++, reconnect);

          return Stream.concat(
            view,
            Stream.unwrap(Effect.as(Effect.sleep(wait), Stream.suspend(loop)))
          );
        }),
        Stream.catch((error) => Stream.make(disconnected(entry, error)))
      );

    return Stream.suspend(loop);
  };

  return {
    hosts,
    connect: (hostId) =>
      Effect.flatMap(linkOf(hostId), (link) => Effect.map(link.live, (live) => live.host)),
    subscribeHost,
    subscribeHosts: () =>
      Stream.mergeAll(
        hosts.map((entry, index) =>
          watchHost(entry).pipe(Stream.map((view) => [index, view] as const))
        ),
        { concurrency: "unbounded" }
      ).pipe(
        Stream.scan(
          () => new Map<number, HostView>(),
          (views, [index, view]) => new Map(views).set(index, view)
        ),
        Stream.filter((views) => views.size > 0),
        Stream.map((views) => [...views.entries()].sort(([a], [b]) => a - b).map(([, v]) => v))
      ),
    subscribeSession: (hostId, sessionId, subscribe = {}) =>
      Stream.unwrap(
        Effect.map(linkOf(hostId), (link) =>
          resilientFeed(
            link,
            {
              initial: null,
              open: (client, state) =>
                client.subscribeSession({
                  sessionId: SessionId.make(sessionId),
                  afterSequence: state?.synchronized === true ? state.sequence : null,
                  turnLimit: subscribe.turnLimit ?? 20,
                }),
              apply: applySessionItem,
              view: (state, connected) =>
                state?.synchronized === true ? sessionView(state, hostId, connected) : null,
            },
            reconnect
          )
        )
      ),
    sendTurn: (hostId, sessionId, prompt) =>
      onSession(hostId, sessionId, (id) =>
        Command.cases.SendTurn.make({ sessionId: id, prompt, attachments: [] })
      ),
    respondToApproval: (hostId, sessionId, requestId, response) =>
      onSession(hostId, sessionId, (id) =>
        Command.cases.RespondToApproval.make({
          sessionId: id,
          requestId: RequestId.make(requestId),
          decision: decisionOf(response),
        })
      ),
    interrupt: (hostId, sessionId) =>
      onSession(hostId, sessionId, (id) => Command.cases.Interrupt.make({ sessionId: id })),
    continue: (hostId, sessionId) =>
      onSession(hostId, sessionId, (id) => Command.cases.Continue.make({ sessionId: id })),
    startSession: (hostId, input) => {
      const sessionId = SessionId.make(randomId());

      const start = (permissionMode: PermissionMode) =>
        Command.cases.StartSession.make({
          sessionId,
          workspaceId: WorkspaceId.make(input.workspaceId),
          harness: input.harness,
          placement:
            input.worktree === undefined
              ? SessionPlacement.cases.InPlace.make({})
              : SessionPlacement.cases.NewWorktree.make({
                  branch: input.worktree.branch,
                  baseRef: input.worktree.baseRef ?? null,
                }),
          permissionMode,
          model: input.model === undefined ? null : ModelId.make(input.model),
          effort: null,
          prompt: input.prompt,
          attachments: [],
        });

      return linkOf(hostId).pipe(
        Effect.flatMap((link) => link.live),
        Effect.flatMap((live) =>
          dispatch(
            hostId,
            start(permissionModeFor(input.permissionMode ?? "supervised", live.capabilities))
          )
        ),
        Effect.as(sessionId)
      );
    },
    transcribe: (hostId, audio) =>
      Stream.unwrap(Effect.map(linkOf(hostId), (link) => transcribeOn(link, audio))),
  } satisfies Polaris;
});
