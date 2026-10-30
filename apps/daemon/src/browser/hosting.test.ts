/**
 * Browser hosting (`hosting.ts`) exercised directly against the service, for the ownership and
 * cleanup properties the Codex review of d23fa0b6 called out (ENG-613): the per-connection claim
 * bound, a timed-out open freeing its quota at once, an atomic accept, a release rerouting to the
 * fallback and revoking the releaser, and an interrupted claim not stranding a concurrent one.
 */
import { describe, expect, test } from "bun:test";
import {
  BYTE_STREAM_WINDOW_BYTES,
  BlobId,
  type BrowserHostItem,
  ByteStreamId,
  SessionId,
} from "@polaris/protocol";
import { Deferred, type Duration, Effect, Exit, Fiber, Predicate, Scope, Stream } from "effect";
import { HostPresence } from "../presence/index.ts";
import type { BlobChannel } from "../services.ts";
import { BrowserHosting, MAX_CLAIMS_PER_CONNECTION } from "./hosting.ts";
import { ByteStreamQuota } from "./quota.ts";

const s1 = SessionId.make("s1");

const s2 = SessionId.make("s2");

const W = BYTE_STREAM_WINDOW_BYTES;

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

/** Polls `probe` for up to a second. */
const eventually = (probe: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100 && !probe(); i++) yield* Effect.sleep("10 millis");

    return probe();
  });

/** A presence whose `lastPresentAt` reads from a map the test controls. */
const fakePresence = (lastPresent: Map<number, number> = new Map()): HostPresence["Service"] => ({
  report: () => 0,
  disconnect: () => {},
  present: () => lastPresent.size > 0,
  lastPresentAt: (id) => lastPresent.get(id) ?? null,
  watch: () => () => {},
});

let blobCounter = 0;

/** A blob channel that hands out fresh ids and never produces bytes: the flow is what we test. */
const fakeBlobs: BlobChannel["Service"] = {
  offer: () => Effect.sync(() => BlobId.make(`blob-${++blobCounter}`)),
  take: () => Effect.die("takeStream only"),
  takeStream: () => Stream.never,
};

const hostingWith = (
  options: { presence?: Map<number, number>; timeout?: Duration.Input; quota?: number } = {}
) =>
  BrowserHosting.make(
    fakePresence(options.presence),
    ByteStreamQuota.make(options.quota),
    options.timeout === undefined ? {} : { acceptTimeout: options.timeout }
  );

/** Registers `connectionId` and resolves the first Open and first Close streamId/reason it sees. */
const registerAndWatch = (hosting: BrowserHosting["Service"], connectionId: number) =>
  Effect.gen(function* () {
    const items = yield* hosting.register(connectionId, fakeBlobs);
    const opened = yield* Deferred.make<ByteStreamId>();
    const closed = yield* Deferred.make<{ streamId: ByteStreamId; reason: string }>();

    yield* Effect.forkScoped(
      Stream.runForEach(items, (item: BrowserHostItem) =>
        Predicate.isTagged(item, "Open")
          ? Effect.asVoid(Deferred.succeed(opened, item.streamId))
          : Predicate.isTagged(item, "Close")
            ? Effect.asVoid(
                Deferred.succeed(closed, { streamId: item.streamId, reason: item.reason })
              )
            : Effect.void
      )
    );

    return { opened, closed };
  });

describe("Browser hosting ownership and cleanup", () => {
  test("a connection cannot claim more Browsers than the per-connection bound", async () => {
    const result = await run(
      Effect.gen(function* () {
        const hosting = hostingWith();
        yield* hosting.register(1, fakeBlobs);

        for (let i = 0; i < MAX_CLAIMS_PER_CONNECTION; i++)
          yield* hosting.claim(1, SessionId.make(`bound-${i}`));

        // Re-claiming one it already holds is not a new slot.
        yield* hosting.claim(1, SessionId.make("bound-0"));
        const over = yield* hosting.claim(1, SessionId.make("over")).pipe(Effect.flip);

        return { over: over._tag, held: over._tag };
      })
    );

    expect(result.over).toBe("NotFound");
  });

  test("a timed-out open frees its quota at once, before the caller's scope closes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const quota = ByteStreamQuota.make();
        const hosting = BrowserHosting.make(fakePresence(), quota, { acceptTimeout: "50 millis" });
        yield* hosting.register(1, fakeBlobs);
        yield* hosting.claim(1, s1);

        const scope = yield* Scope.make();
        const refused = yield* hosting.open(s1, "cdp").pipe(Scope.provide(scope), Effect.flip);
        // The caller's scope is still open; the fix released the quota on the failure itself.
        const quotaWhileScopeOpen = quota.open(1);
        yield* Scope.close(scope, Exit.void);

        return { refused: refused._tag, quotaWhileScopeOpen };
      })
    );

    expect(result.refused).toBe("BrowserStreamRefused");
    expect(result.quotaWhileScopeOpen).toBe(0);
  });

  test("a second accept for a still-pending stream is refused, not silently a no-op", async () => {
    const result = await run(
      Effect.gen(function* () {
        const hosting = hostingWith({ timeout: "2 seconds" });
        const { opened } = yield* registerAndWatch(hosting, 1);
        yield* hosting.claim(1, s1);

        const scope = yield* Scope.make();

        const open = yield* Effect.forkChild(
          hosting.open(s1, "cdp").pipe(Scope.provide(scope), Effect.exit)
        );

        const streamId = yield* Deferred.await(opened);

        const answer = (upstream: string) =>
          hosting.accept(1, streamId, BlobId.make(upstream), W).pipe(
            Effect.as("won"),
            Effect.catch((error) => Effect.succeed(error._tag))
          );

        // Back-to-back while the stream is still pending: the second hits the atomic guard, not
        // the kind check, and must be refused rather than no-op on an already-set Deferred.
        const first = yield* answer("up-a");
        const second = yield* answer("up-b");

        yield* Fiber.join(open);
        yield* Scope.close(scope, Exit.void);

        return { first, second };
      })
    );

    expect(result.first).toBe("won");
    expect(result.second).toBe("NotFound");
  });

  test("releasing a claim reroutes to the present fallback and revokes the releaser's stream", async () => {
    const result = await run(
      Effect.gen(function* () {
        const present = new Map<number, number>();

        const hosting = BrowserHosting.make(fakePresence(present), ByteStreamQuota.make(), {
          acceptTimeout: "2 seconds",
        });

        const mac = yield* registerAndWatch(hosting, 1);
        yield* hosting.register(2, fakeBlobs);
        present.set(2, Date.now()); // The laptop is present: it is the fallback host.
        yield* hosting.claim(1, s1);

        const scope = yield* Scope.make();

        const open = yield* Effect.forkChild(
          hosting.open(s1, "cdp").pipe(Scope.provide(scope), Effect.exit)
        );

        const streamId = yield* Deferred.await(mac.opened);
        yield* hosting.accept(1, streamId, BlobId.make("up"), W);
        yield* Fiber.join(open);

        // The mac releases s1: hosting reroutes to the laptop, and the mac's stream is revoked.
        yield* hosting.release(1, s1);
        const close = yield* Deferred.await(mac.closed).pipe(Effect.timeout("1 second"));
        const reroutedTo = yield* hosting.current(s1);
        yield* Scope.close(scope, Exit.void);

        return { reason: close.reason, streamId: close.streamId === streamId, reroutedTo };
      })
    );

    expect(result.reason).toBe("revoked");
    expect(result.streamId).toBe(true);
    expect(result.reroutedTo).toBe(2);
  });

  test("interrupting a claim that awaits registration drops its waiter but not a sibling's", async () => {
    const result = await run(
      Effect.gen(function* () {
        const hosting = hostingWith({ timeout: "2 seconds" });

        // Connection 7 has not registered yet: both claims wait on it.
        const claim1 = yield* Effect.forkChild(hosting.claim(7, s1).pipe(Effect.exit));
        const claim2 = yield* Effect.forkChild(hosting.claim(7, s2).pipe(Effect.exit));
        yield* eventually(() => hosting.awaitingClaims(7) === 2);
        const bothWaiting = hosting.awaitingClaims(7);

        // Cancelling one claim removes only its waiter; the sibling keeps waiting.
        yield* Fiber.interrupt(claim1);
        const afterInterrupt = yield* eventually(() => hosting.awaitingClaims(7) === 1);

        // The connection registers: the surviving claim resolves and takes s2.
        yield* hosting.register(7, fakeBlobs);
        const second = yield* Fiber.join(claim2).pipe(Effect.timeout("1 second"));
        const held = yield* hosting.current(s2);

        return {
          bothWaiting,
          leakCleared: afterInterrupt,
          survived: Exit.isSuccess(second),
          held,
          finalWaiters: hosting.awaitingClaims(7),
        };
      })
    );

    expect(result.bothWaiting).toBe(2);
    expect(result.leakCleared).toBe(true);
    expect(result.survived).toBe(true);
    expect(result.held).toBe(7);
    expect(result.finalWaiters).toBe(0);
  });

  test("a claim for a session the Daemon does not know is refused", async () => {
    const result = await run(
      Effect.gen(function* () {
        const known = SessionId.make("known");

        // Only `known` is hostable; every other session is unknown or archived.
        const hosting = BrowserHosting.make(
          fakePresence(),
          ByteStreamQuota.make(),
          {},
          (sessionId) => Effect.succeed(sessionId === known)
        );

        yield* hosting.register(1, fakeBlobs);

        yield* hosting.claim(1, known);
        const unknown = yield* hosting.claim(1, SessionId.make("ghost")).pipe(Effect.flip);

        return { unknown: unknown._tag, heldKnown: yield* hosting.current(known) };
      })
    );

    expect(result.unknown).toBe("NotFound");
    expect(result.heldKnown).toBe(1);
  });
});
