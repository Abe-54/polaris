/**
 * The live feeds behind `window.polaris.subscribe`. Host and session feeds are
 * `@polaris/client`'s resumable feeds, so every window shares one upstream
 * subscription per stream: a new subscriber gets the cached Snapshot at once,
 * then events, and the feed survives reconnects.
 */
import {
  attachTerminal,
  type HostConnection,
  type LiveSession,
  watchHostStats,
} from "@polaris/client";
import { Effect, flow, Predicate, Schema, Stream, SubscriptionRef } from "effect";
import type { IpcError, SubscriptionItem } from "../../shared/api.ts";
import {
  SubscriptionInputs,
  type SubscriptionInput,
  type SubscriptionKind,
} from "../../shared/contract.ts";
import { type ClientServices, HostDirectory, toIpcError } from "../hosts.ts";
import { githubOpeners } from "../github/ipc.ts";
import { gitOpeners } from "./git.ts";
import { constellationFeed } from "./constellation.ts";
import { Machines } from "../machines/service.ts";
import type { PredictionBridge } from "../prediction/bridge.ts";
import { browserOpeners } from "../browser/ipc.ts";
import type { Registry as Browsers } from "../browser/registry.ts";

export type Feed<K extends SubscriptionKind> = Stream.Stream<
  SubscriptionItem<K>,
  IpcError,
  ClientServices
>;

const onHost = <A, E extends { readonly _tag: string; readonly message: string }>(
  hostKey: string,
  use: (connection: HostConnection) => Stream.Stream<A, E>
): Stream.Stream<A, IpcError, HostDirectory> =>
  Stream.unwrap(
    Effect.map(
      HostDirectory.use((dir) => dir.connection(hostKey)),
      (connection) => use(connection)
    )
  ).pipe(Stream.mapError(toIpcError));

/** Streams bound to one live connection end when it drops; the renderer resubscribes. */
const onLive = <A, E extends { readonly _tag: string; readonly message: string }>(
  hostKey: string,
  use: (session: LiveSession) => Stream.Stream<A, E>
) =>
  onHost(hostKey, (connection) =>
    Stream.unwrap(Effect.map(connection.session, (session) => use(session)))
  );

type Openers = { readonly [K in SubscriptionKind]: (input: SubscriptionInput<K>) => Feed<K> };

const openers: Openers = {
  "prediction.edit": () =>
    Stream.fail({ code: "Unavailable", message: "Edit prediction unavailable" }),
  "prediction.complete": () =>
    Stream.fail({ code: "Unavailable", message: "Tab completion unavailable" }),
  "prediction.managed.watch": () =>
    Stream.fail({ code: "Unavailable", message: "Tab completion unavailable" }),
  ...githubOpeners,
  ...gitOpeners,
  ...browserOpeners(undefined),
  hosts: () => Stream.unwrap(HostDirectory.useSync((dir) => SubscriptionRef.changes(dir.views))),
  machines: () =>
    Stream.unwrap(Machines.useSync((machines) => SubscriptionRef.changes(machines.views))),
  host: ({ hostKey }) => onHost(hostKey, (connection) => connection.subscribeHost),
  session: ({ hostKey, sessionId, turnLimit }) =>
    onHost(hostKey, (connection) => connection.subscribeSession(sessionId, { turnLimit })),
  terminal: ({ hostKey, terminalId }) =>
    onLive(hostKey, (session) => attachTerminal(session, terminalId)),
  "files.watch": ({ hostKey, root }) =>
    onLive(hostKey, (session) => session.client["files.watch"]({ root })),
  "files.watchFile": ({ hostKey, path }) =>
    onLive(hostKey, (session) =>
      session.client["files.watchFile"]({ path }).pipe(
        Stream.map(({ path, version }) => ({
          path,
          version:
            version === null
              ? null
              : { mtimeMs: version.mtimeMs, size: version.size, hash: version.hash },
        }))
      )
    ),
  usage: ({ hostKey }) => onLive(hostKey, (session) => session.client["usage.watch"]({})),
  "harness.availability": ({ hostKey }) =>
    onLive(hostKey, (session) => session.client["harness.watchAvailability"]({})),
  continuity: ({ hostKey }) => onLive(hostKey, (session) => session.client["continuity.watch"]({})),
  "plan-limits": ({ hostKey }) =>
    onLive(hostKey, (session) =>
      session.client["usage.watch"]({}).pipe(
        Stream.flatMap((item) =>
          Predicate.isTagged(item, "PlanLimitChanged") ? Stream.make(item.limit) : Stream.empty
        )
      )
    ),
  // Ends at once, empty, on a Daemon without `host.stats`.
  "host.stats": ({ hostKey }) => onLive(hostKey, watchHostStats),
  "devices.watch": ({ hostKey }) => onLive(hostKey, (session) => session.client["devices.watch"]()),
  "review.watchRiskSummary": ({ hostKey, summaryId }) =>
    onLive(hostKey, (session) => session.client["review.watchRiskSummary"]({ summaryId })),
  "inline.propose": ({ hostKey, ...request }) =>
    onLive(hostKey, (session) => session.client["inline.propose"](request)),
  constellation: constellationFeed,
};

export const isSubscriptionKind = (kind: string): kind is SubscriptionKind =>
  Object.hasOwn(SubscriptionInputs, kind);

const predictionOpeners = (prediction?: PredictionBridge, browser?: Browsers): Openers => ({
  ...openers,
  ...browserOpeners(browser),
  "prediction.edit": (value) => prediction?.edit(value) ?? openers["prediction.edit"](value),
  "prediction.complete": (value) =>
    prediction?.complete(value) ?? openers["prediction.complete"](value),
  "prediction.managed.watch": (value) =>
    prediction?.watchManaged(value) ?? openers["prediction.managed.watch"](value),
});

/** Decodes a renderer's input for `kind` (untrusted), then opens the feed. */
export const feedOpener = <K extends SubscriptionKind>(
  kind: K,
  prediction?: PredictionBridge,
  browser?: Browsers
) =>
  flow(
    Schema.decodeUnknownEffect(SubscriptionInputs[kind]),
    Effect.mapError((error): IpcError => ({ code: "InvalidInput", message: error.message })),
    Effect.map((input): Feed<K> => predictionOpeners(prediction, browser)[kind](input)),
    Stream.unwrap
  );
