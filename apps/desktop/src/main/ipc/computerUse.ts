/**
 * Computer use on a Host (ENG-846): its `computerUse.*` RPCs, only on a Host whose Daemon
 * announces `computer-use`, so a remote Host's setup runs on that Host.
 */
import type { LiveSession } from "@polaris/client";
import { type PreviewFrame, type PreviewLink, Unsupported } from "@polaris/protocol";
import { Effect, Match, Schema, Stream } from "effect";
import type { IpcError } from "../../shared/api.ts";
import { PreviewFeedItem, type PreviewImage } from "../../shared/computerUseContract.ts";
import type { RequestInput, SubscriptionInput } from "../../shared/contract.ts";
import { admitRaster } from "../../shared/raster/index.ts";
import { HostDirectory, hostKind, toIpcError } from "../hosts.ts";

const CAPABILITY = "computer-use" as const;

const LIVE_CAPABILITY = "computer-use.preview" as const;

type Tagged = { readonly _tag: string; readonly message: string };

const toComputerUseIpcError = (error: Tagged): IpcError =>
  Schema.is(Unsupported)(error)
    ? { code: "Unsupported", message: "Computer use needs a newer daemon on this host" }
    : toIpcError(error);

const live = (hostKey: string) =>
  HostDirectory.use((dir) => dir.connection(hostKey)).pipe(
    Effect.flatMap((connection) => connection.session)
  );

const supported = (session: LiveSession) => session.capabilities.includes(CAPABILITY);

/** The Daemon caps frames by link: only ssh crosses a network from here. */
const linkOf = (hostKey: string) =>
  HostDirectory.useSync((dir): PreviewLink => {
    const entry = dir.entry(hostKey);

    return entry !== undefined && hostKind(entry) === "ssh" ? "remote" : "local";
  });

/** A frame's JPEG, admitted (`admitRaster`) before the renderer decodes it; null when refused. */
const imageOf = (session: LiveSession, frame: PreviewFrame) =>
  Effect.map(session.blobs.take(frame.blobId), (bytes): PreviewImage | null =>
    admitRaster(bytes).kind === "admitted"
      ? {
          bytes,
          width: frame.width,
          height: frame.height,
          capturedAt: frame.capturedAt,
          window: frame.window,
        }
      : null
  );

/**
 * One frame's blob at a time: the Daemon slides its slot while this one is taken, so a slow
 * renderer gets the newest frame next and never a backlog.
 */
const watchPreview = (
  session: LiveSession,
  { sessionId, maxEdgePx }: SubscriptionInput<"computerUse.preview.watch">,
  link: PreviewLink
): Stream.Stream<PreviewFeedItem, Tagged> =>
  session.client["computerUse.preview.watch"]({ sessionId, maxEdgePx, link }).pipe(
    Stream.mapEffect((item) =>
      Match.value(item).pipe(
        Match.tagsExhaustive({
          Frame: ({ frame }) =>
            Effect.map(imageOf(session, frame), (image): ReadonlyArray<PreviewFeedItem> =>
              image === null ? [] : [PreviewFeedItem.Frame({ image })]
            ),
          Idle: ({ reason }) =>
            Effect.succeed<ReadonlyArray<PreviewFeedItem>>([PreviewFeedItem.Idle({ reason })]),
        })
      )
    ),
    Stream.flatMap((items) => Stream.fromIterable(items))
  );

const onHost = <A, E extends Tagged>(
  hostKey: string,
  use: (session: LiveSession) => Effect.Effect<A, E>
) =>
  live(hostKey).pipe(
    Effect.flatMap((session): Effect.Effect<A, E | Unsupported> =>
      supported(session) ? use(session) : Effect.fail(new Unsupported({ capability: CAPABILITY }))
    ),
    Effect.mapError(toComputerUseIpcError)
  );

export const computerUseHandlers = {
  "computerUse.status": ({ hostKey, refresh }: RequestInput<"computerUse.status">) =>
    onHost(hostKey, (session) => session.client["computerUse.status"]({ refresh })),
  "computerUse.enable": ({ hostKey }: RequestInput<"computerUse.enable">) =>
    onHost(hostKey, (session) => session.client["computerUse.enable"]({})),
  "computerUse.disable": ({ hostKey }: RequestInput<"computerUse.disable">) =>
    onHost(hostKey, (session) => session.client["computerUse.disable"]({})),
  "computerUse.openSetup": ({ hostKey, permission }: RequestInput<"computerUse.openSetup">) =>
    onHost(hostKey, (session) => session.client["computerUse.openSetup"]({ permission })),
  "computerUse.removeAllowedApp": ({
    hostKey,
    appId,
  }: RequestInput<"computerUse.removeAllowedApp">) =>
    onHost(hostKey, (session) => session.client["computerUse.removeAllowedApp"]({ appId })),
  "computerUse.allowedApps.add": ({
    hostKey,
    appId,
  }: RequestInput<"computerUse.allowedApps.add">) =>
    onHost(hostKey, (session) => session.client["computerUse.allowedApps.add"]({ appId })),
  "computerUse.preview.latest": ({
    hostKey,
    sessionId,
    maxEdgePx,
  }: RequestInput<"computerUse.preview.latest">) =>
    onHost(hostKey, (session) =>
      session.client["computerUse.preview.latest"]({ sessionId, maxEdgePx }).pipe(
        Effect.flatMap((frame) => (frame === null ? Effect.succeed(null) : imageOf(session, frame)))
      )
    ),
};

/** Ends with the connection, or at once on a Daemon without computer use; the renderer resubscribes. */
export const computerUseOpeners = {
  "computerUse.watch": ({ hostKey }: SubscriptionInput<"computerUse.watch">) =>
    Stream.unwrap(
      Effect.map(live(hostKey), (session) =>
        supported(session) ? session.client["computerUse.watch"]({}) : Stream.empty
      )
    ).pipe(Stream.mapError(toComputerUseIpcError)),
  "computerUse.preview.watch": (input: SubscriptionInput<"computerUse.preview.watch">) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const session = yield* live(input.hostKey);

        if (!session.capabilities.includes(LIVE_CAPABILITY))
          return Stream.succeed<PreviewFeedItem>(PreviewFeedItem.NoLive());

        return watchPreview(session, input, yield* linkOf(input.hostKey));
      })
    ).pipe(Stream.mapError(toComputerUseIpcError)),
};
