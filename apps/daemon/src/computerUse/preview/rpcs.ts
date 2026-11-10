/**
 * `computerUse.preview.watch` and `computerUse.preview.latest` (packages/protocol/computer-use.md,
 * "Preview"). The other computer use RPCs keep their own layer.
 */
import {
  AppRef,
  AppWindow,
  NotFound,
  PreviewFrame,
  PreviewItem,
  previewEdge,
  type SessionId,
  Unsupported,
} from "@polaris/protocol";
import { Effect, Layer, Option, Stream } from "effect";
import { BlobChannel } from "../../services.ts";
import { EventStore } from "../../store/EventStore.ts";
import { PREVIEW_CAPABILITY, PreviewRpcs } from "./group.ts";
import { PreviewEvent, type PreviewImage, PreviewSource } from "./source.ts";

/** Offers the JPEG to this request's Client and answers the frame that names it. */
const frameOf = Effect.fnUntraced(function* (image: PreviewImage) {
  const blobs = yield* BlobChannel;
  const blobId = yield* blobs.offer(image.jpeg);

  return new PreviewFrame({
    blobId,
    bytes: image.jpeg.length,
    width: image.width,
    height: image.height,
    capturedAt: new Date(image.capturedAt).toISOString(),
    app: new AppRef(image.app),
    window: image.window === null ? null : new AppWindow(image.window),
  });
});

/** Whether this Host has the Agent Session. */
export type SessionKnown = (sessionId: SessionId) => Effect.Effect<boolean>;

export const previewHandlers = (sessionKnown: SessionKnown) =>
  PreviewRpcs.toLayer(
    Effect.gen(function* () {
      const source = yield* PreviewSource;

      const known = (sessionId: SessionId) =>
        Effect.flatMap(sessionKnown(sessionId), (found) =>
          found ? Effect.void : Effect.fail(new NotFound({ what: "Agent Session", id: sessionId }))
        );

      return {
        "computerUse.preview.watch": ({ sessionId, maxEdgePx, link }) =>
          source.live
            ? Stream.unwrap(
                Effect.as(
                  known(sessionId),
                  // The frame is offered only once the Client took the item before it.
                  source.watch({ sessionId, edge: previewEdge(maxEdgePx), link }).pipe(
                    Stream.mapEffect(
                      PreviewEvent.$match({
                        Idle: ({ reason }) =>
                          Effect.succeed(PreviewItem.cases.Idle.make({ reason })),
                        Frame: ({ image }) =>
                          Effect.map(frameOf(image), (frame) =>
                            PreviewItem.cases.Frame.make({ frame })
                          ),
                      })
                    )
                  )
                )
              )
            : Stream.fail(new Unsupported({ capability: PREVIEW_CAPABILITY })),
        "computerUse.preview.latest": ({ sessionId, maxEdgePx }) =>
          Effect.gen(function* () {
            yield* known(sessionId);
            const image = yield* source.latest({ sessionId, edge: previewEdge(maxEdgePx) });

            return Option.isNone(image) ? null : yield* frameOf(image.value);
          }),
      };
    })
  );

/** What the Daemon mounts (lazily, `transport/lazyPreview.ts`): sessions from the event store. */
export const PreviewHandlersLive = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* EventStore;

    return previewHandlers((sessionId) =>
      Effect.map(store.model, (model) => model.sessions.has(sessionId))
    );
  })
);
