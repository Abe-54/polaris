import { expect, test } from "bun:test";
import { BlobId, SessionId } from "@polaris/protocol";
import { Context, Effect, Fiber, Layer, Stream } from "effect";
import type { HostPresence } from "../presence/index.ts";
import type { BlobChannel } from "../services.ts";
import { BrowserHosting } from "./hosting.ts";
import { browserHostingSlot } from "./hostingSlot.ts";
import { ByteStreamQuota } from "./quota.ts";

const presence: HostPresence["Service"] = {
  report: () => 0,
  disconnect: () => {},
  present: () => false,
  lastPresentAt: () => null,
  watch: () => () => {},
};

const blobs: BlobChannel["Service"] = {
  offer: () => Effect.succeed(BlobId.make("blob-1")),
  take: () => Effect.die("takeStream only"),
  takeStream: () => Stream.never,
};

test("a call made before the transport binds its hosting waits, then sees the connection registered there", async () => {
  const slot = browserHostingSlot();
  let answeredEarly = false;

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const early = Context.get(yield* Layer.build(slot.layer), BrowserHosting);

        const asked = yield* Effect.forkScoped(
          early
            .current(SessionId.make("s1"))
            .pipe(Effect.tap(() => Effect.sync(() => (answeredEarly = true))))
        );

        yield* Effect.sleep("20 millis");
        const settledBeforeBind = answeredEarly;
        const awaitingBeforeBind = early.awaitingClaims(3);

        const real = BrowserHosting.make(presence, ByteStreamQuota.make());
        yield* real.register(3, blobs);
        yield* Layer.build(slot.bind.pipe(Layer.provide(Layer.succeed(BrowserHosting)(real))));

        return { settledBeforeBind, awaitingBeforeBind, host: yield* Fiber.join(asked) };
      })
    )
  );

  // Before the bind nothing answers (no NoDesktopApp either); after it, the real registration does.
  expect(result).toEqual({ settledBeforeBind: false, awaitingBeforeBind: 0, host: 3 });
});
