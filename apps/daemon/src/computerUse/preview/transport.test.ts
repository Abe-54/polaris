/** The preview RPCs over the real transport: frames as blobs, unsubscribe on disconnect. */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import {
  AppId,
  AppRef,
  AppWindow,
  DaemonRpcs,
  PreviewItem,
  SessionId,
  NotFound,
  Unsupported,
} from "@polaris/protocol";
import { Effect, Exit, Fiber, Layer, Option, Scope, Stream } from "effect";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";
import { HostSecrets } from "../../secrets/index.ts";
import { startServer } from "../../transport/server.ts";
import { captureLayer } from "./capture.ts";
import { fakeHelper, frameRecord } from "./capture.testing.ts";
import { PREVIEW_CAPABILITY } from "./group.ts";
import { previewHandlers } from "./rpcs.ts";
import type { PreviewSource } from "./source.ts";
import { stillLayer } from "./still.ts";
import { PreviewTargets } from "./targets.ts";

const hello = { clientName: "test", clientVersion: "0", deviceLabel: "test", capabilities: [] };

const session = SessionId.make("s1");

const textEdit = new AppRef({ id: AppId.make("com.apple.TextEdit"), name: "TextEdit" });

const window = new AppWindow({ id: "7", title: "Untitled" });

const jpeg = new Uint8Array([0xff, 0xd8, 0x0a, 0x01, 0xff, 0xd9]);

const until = (what: string, done: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 400 && !done(); tries++) yield* Effect.sleep("5 millis");

    if (!done()) return yield* Effect.die(`timed out waiting for ${what}`);
  });

/** A Daemon serving the preview from `source`, where only `session` exists and has acted. */
const serve = (source: Layer.Layer<PreviewSource, never, PreviewTargets>) =>
  Effect.gen(function* () {
    const root = newTempDir("pl-preview-", { short: true });
    yield* Effect.addFinalizer(() => Effect.promise(() => removeTempDirSettled(root)));

    const acted = Layer.effectDiscard(
      Effect.gen(function* () {
        const targets = yield* PreviewTargets;
        yield* targets.acted(session, { app: textEdit, window, screenshot: null });
      })
    );

    const server = yield* startServer({
      root,
      socketPath: join(root, "d.sock"),
      lockPath: join(root, "d.lock"),
      handlers: previewHandlers((id) => Effect.succeed(id === session)).pipe(
        Layer.provide(Layer.merge(source, acted)),
        Layer.provide(PreviewTargets.layer)
      ),
      capabilities: [PREVIEW_CAPABILITY],
      secrets: HostSecrets.memory(),
    });

    const scope = yield* Scope.make();

    const connection = yield* connectRpcWith(
      DaemonRpcs,
      yield* socketTransport(server.socketPath)
    ).pipe(Scope.provide(scope));

    yield* connection.client.hello(hello);

    return { ...connection, disconnect: Scope.close(scope, Exit.void) };
  });

test("a watching Client gets the frame's bytes as a blob, and its disconnect ends the capture", () => {
  const helper = fakeHelper();

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { client, blobs, disconnect } = yield* serve(
          captureLayer().pipe(Layer.provide(helper.layer))
        );

        const watch = client["computerUse.preview.watch"]({
          sessionId: session,
          maxEdgePx: 640,
          link: "local",
        });

        const first = yield* Effect.forkChild(Stream.runHead(watch));
        yield* until("the tool", () => helper.tools.length > 0);
        helper.tools[0]!.emit(
          frameRecord({ window: 7, width: 640, height: 400, capturedAt: 1_794_000_000_000 }, jpeg)
        );

        const item = Option.getOrThrow(yield* Fiber.join(first));
        const frame = PreviewItem.guards.Frame(item) ? item.frame : null;

        expect(frame).toMatchObject({
          bytes: jpeg.length,
          width: 640,
          height: 400,
          capturedAt: "2026-11-06T21:20:00.000Z",
          app: textEdit,
          window,
        });
        expect(yield* blobs.take(frame!.blobId)).toEqual(jpeg);

        // Still watching when the connection goes: that alone must stop the tool.
        yield* Effect.forkChild(Stream.runDrain(watch));
        yield* until("a tool for the second watch", () => helper.running() === 1);
        yield* disconnect;
        yield* until("the tool to be killed", () => helper.running() === 0);
      })
    )
  );
});

test("an unknown session is not found, and a Host with no live capture says so", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { client, disconnect } = yield* serve(stillLayer);
        const other = SessionId.make("nobody");

        const errors = yield* Effect.all([
          Effect.flip(client["computerUse.preview.latest"]({ sessionId: other, maxEdgePx: null })),
          Effect.flip(
            Stream.runDrain(
              client["computerUse.preview.watch"]({
                sessionId: session,
                maxEdgePx: null,
                link: "local",
              })
            )
          ),
        ]);

        expect(errors).toEqual([
          new NotFound({ what: "Agent Session", id: "nobody" }),
          new Unsupported({ capability: "computer-use.preview" }),
        ]);
        // No screenshot was ever taken for it: nothing to show, which is not an error.
        expect(
          yield* client["computerUse.preview.latest"]({ sessionId: session, maxEdgePx: null })
        ).toBeNull();
        yield* disconnect;
      })
    )
  ));
