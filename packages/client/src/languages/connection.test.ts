// oxlint-disable anti-slop/no-unknown-parameters -- Promise rejection values are decoded with LanguageError at this fake transport boundary.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as P from "@polaris/protocol";
import { Effect, Layer, Redacted, Stream, SubscriptionRef, Predicate, Schema } from "effect";
import { HostTarget, makeHostConnection, languageSessionAuthority } from "../HostConnection.ts";
import { socketTransport } from "../transport.ts";
import { LanguageAccess } from "./index.ts";
import { languageTransportFor } from "./connection.ts";
import { startServer } from "../../../../apps/daemon/src/transport/server.ts";
import { ServerRpcs } from "../../../../apps/daemon/src/transport/rpcs.ts";
import { BlobChannel } from "../../../../apps/daemon/src/services.ts";
import { languageIdentityFor } from "../../../../apps/daemon/src/transport/languageIdentity.ts";

const proof = Redacted.make("a".repeat(64), { label: "language identity" });

const temporary = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync("/tmp/pl-a0-client-")),
  (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true }))
);

const options = (root: string) => ({
  root,
  socketPath: join(root, "d.sock"),
  lockPath: join(root, "d.lock"),
});

const identity = {
  name: "fake",
  version: "0",
  deviceLabel: "fixture",
  capabilities: ["blobs", "languages", "languages.preview-media"] as const,
};

const availability = { toolIds: [], checkout: null, refresh: false, phase: "feature" as const };

test("actual one connection routes validated language RPC/feed/blob and invalidates its epoch", async () => {
  let activeFeed = 0;
  let feedStarted = 0;
  let activeRequest = 0;
  let blobCalls = 0;
  let hostId: P.HostId | null = null;
  let entered = () => {};

  const requestEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const handlers = Layer.mergeAll(
    ServerRpcs.toLayerHandler("languages.host.state", () =>
      Effect.sync(() =>
        P.LanguageHostState.make({
          hostId: hostId!,
          platform: { os: "darwin", arch: "arm64", libc: "none" },
          tools: [],
        })
      )
    ),
    ServerRpcs.toLayerHandler("languages.host.state.watch", () =>
      Stream.fromEffect(
        Effect.sync(() =>
          P.LanguageHostState.make({
            hostId: hostId!,
            platform: { os: "darwin", arch: "arm64", libc: "none" },
            tools: [],
          })
        )
      )
    ),
    ServerRpcs.toLayerHandler("languages.availability", (_input, { client }) => {
      if (hostId === null || languageIdentityFor(client, hostId) === null)
        return Effect.fail(
          new P.LanguageError({
            reason: "not-owner",
            message: "Fixture authority unavailable",
            retryable: false,
          })
        );

      return Effect.succeed([]);
    }),
    ServerRpcs.toLayerHandler("languages.availability.watch", () =>
      Stream.concat(
        Stream.fromEffect(
          Effect.sync(() => {
            activeFeed++;
            feedStarted++;

            return [];
          })
        ),
        Stream.never
      ).pipe(
        Stream.ensuring(
          Effect.sync(() => {
            activeFeed--;
          })
        )
      )
    ),
    ServerRpcs.toLayerHandler("languages.catalog", () =>
      Effect.andThen(
        Effect.sync(() => {
          activeRequest++;
          entered();
        }),
        Effect.never
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            activeRequest--;
          })
        )
      )
    ),
    ServerRpcs.toLayerHandler("files.read", () =>
      Effect.gen(function* () {
        const blobs = yield* BlobChannel;
        blobCalls++;
        const blobId = yield* blobs.offer(new Uint8Array([1, 2, 3, 4]));

        return {
          size: 4,
          mimeType: "application/octet-stream",
          content: P.FileContent.cases.Blob.make({ blobId }),
        };
      })
    )
  );

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;

        const server = yield* startServer({
          ...options(root),
          handlers,
          capabilities: ["languages", "languages.preview-media", "files.read"],
        });

        hostId = server.hostInfo.hostId;
        let close: Effect.Effect<void> = Effect.void;

        const connector = Effect.map(socketTransport(server.socketPath), (transport) => {
          close = transport.close;

          return transport;
        });

        const conn = yield* makeHostConnection({
          key: "fixture",
          name: "fixture",
          target: HostTarget.Local({ socketPath: server.socketPath }),
          identity,
          connector,
          clientIdentity: { proof, expectedHostId: hostId },
        });

        const session = yield* conn.awaitSession;
        const transport = languageTransportFor(session);

        if (transport === null) return yield* Effect.die("Missing fixture authority");

        const response = yield* Effect.promise(() =>
          transport.invoke("languages.availability", availability, new AbortController().signal)
        );

        const hostState = yield* Effect.promise(() =>
          transport.invoke(
            "languages.host.state",
            { toolIds: [], refresh: true },
            new AbortController().signal
          )
        );

        expect(Schema.decodeUnknownSync(P.LanguageHostState)(hostState).hostId).toBe(hostId);

        const hostFeed = transport
          .watch(
            "languages.host.state.watch",
            { toolIds: [], refresh: false },
            new AbortController().signal
          )
          [Symbol.asyncIterator]();

        const hostSnapshot = yield* Effect.promise(() => hostFeed.next());

        expect(Schema.decodeUnknownSync(P.LanguageHostState)(hostSnapshot.value).tools).toEqual([]);
        yield* Effect.promise(async () => {
          await hostFeed.return?.();
        });

        const feedController = new AbortController();

        const iterator = transport
          .watch("languages.availability.watch", availability, feedController.signal)
          [Symbol.asyncIterator]();

        yield* Effect.promise(() => iterator.next());
        feedController.abort();
        yield* Effect.promise(
          () => iterator.return?.() ?? Promise.resolve({ done: true, value: undefined })
        );

        const read = yield* session.client["files.read"]({
          path: "/fixture",
          offset: 0,
          length: 4,
        });

        if (!Predicate.isTagged(read.content, "Blob"))
          return yield* Effect.die("Missing fixture Blob");
        const blobId = read.content.blobId;

        const bytes = yield* Effect.promise(() =>
          transport.takeBlob(blobId, 4, new AbortController().signal)
        );

        const readAgain = yield* session.client["files.read"]({
          path: "/fixture",
          offset: 0,
          length: 4,
        });

        if (!Predicate.isTagged(readAgain.content, "Blob"))
          return yield* Effect.die("Missing fixture Blob");
        const secondBlobId = readAgain.content.blobId;

        const bounded = yield* Effect.promise(() =>
          transport.takeBlob(secondBlobId, 3, new AbortController().signal).then(
            () => null,
            (error: unknown) => Schema.decodeUnknownSync(P.LanguageError)(error).reason
          )
        );

        const originalClient = session.client;
        const originalBlobs = session.blobs;

        Object.defineProperty(session, "client", {
          value: { ...originalClient },
          configurable: true,
        });
        const replacedClientAuthority = languageSessionAuthority(session);

        Object.defineProperty(session, "client", { value: originalClient });
        Object.defineProperty(session, "blobs", {
          value: { ...originalBlobs },
          configurable: true,
        });
        const replacedBlobAuthority = languageSessionAuthority(session);

        Object.defineProperty(session, "blobs", { value: originalBlobs });
        const copiedSession = { ...session };
        const forged = languageTransportFor(copiedSession);
        let current = session;
        const replacementTransport = languageTransportFor(session, () => current);
        current = copiedSession;

        const replaced = yield* Effect.promise(() =>
          replacementTransport!
            .invoke("languages.availability", availability, new AbortController().signal)
            .then(
              () => null,
              (error: unknown) => Schema.decodeUnknownSync(P.LanguageError)(error).reason
            )
        );

        const rejected = yield* Effect.promise(() =>
          transport
            .invoke(
              "languages.availability",
              { ...availability, toolIds: "invalid" },
              new AbortController().signal
            )
            .then(
              () => false,
              () => true
            )
        );

        const pending = transport
          .invoke("languages.catalog", {}, new AbortController().signal)
          .then(
            () => false,
            () => true
          );

        yield* Effect.promise(() => requestEntered);
        yield* close;
        const cancelled = yield* Effect.promise(() => pending);
        yield* conn.changes.pipe(
          Stream.filter((state) => state.state === "connected" && state.epoch > session.epoch),
          Stream.runHead
        );
        const next = yield* conn.awaitSession;

        return {
          response,
          bytes: [...bytes],
          rejected,
          cancelled,
          bounded,
          forged,
          replaced,
          replacedClientAuthority,
          replacedBlobAuthority,
          oldAborted: session.signal?.aborted,
          oldAuthority: languageSessionAuthority(session),
          nextAuthority: languageSessionAuthority(next),
          oldEpoch: session.epoch,
          nextEpoch: next.epoch,
          identity: session.languageIdentity,
          nextIdentity: next.languageIdentity,
          connections: server.connections(),
          status: yield* SubscriptionRef.get(conn.status),
        };
      })
    )
  );

  expect(result.response).toEqual([]);
  expect(result.bytes).toEqual([1, 2, 3, 4]);
  expect(result.rejected).toBe(true);
  expect(result.cancelled).toBe(true);
  expect(result.oldAborted).toBe(true);
  expect(result.oldAuthority).toBeNull();
  expect(result.nextAuthority).not.toBeNull();
  expect(result.nextEpoch).toBeGreaterThan(result.oldEpoch ?? 0);
  expect(result.identity).toEqual(result.nextIdentity);
  expect(result.connections).toBe(1);
  expect(feedStarted).toBe(1);
  expect(activeFeed).toBe(0);
  expect(activeRequest).toBe(0);
  expect(blobCalls).toBe(2);
  expect(result.bounded).toBe("too-large");
  expect(result.forged).toBeNull();
  expect(result.replacedClientAuthority).toBeNull();
  expect(result.replacedBlobAuthority).toBeNull();
  expect(result.replaced).toBe("not-connected");
  expect(JSON.stringify(result).includes(Redacted.value(proof))).toBe(false);
});

test("missing proof and old/partial capability peers keep languages unavailable", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;
        const server = yield* startServer(options(root));

        const conn = yield* makeHostConnection({
          key: "old",
          name: "old",
          target: HostTarget.Local({ socketPath: server.socketPath }),
          identity,
        });

        const old = yield* conn.awaitSession;

        const authenticated = yield* makeHostConnection({
          key: "partial",
          name: "partial",
          target: HostTarget.Local({ socketPath: server.socketPath }),
          identity,
          clientIdentity: { proof },
        });

        const partial = yield* authenticated.awaitSession;

        return {
          oldTransport: languageTransportFor(old),
          oldIdentity: languageSessionAuthority(old),
          partialTransport: languageTransportFor(partial),
          partialIdentity: languageSessionAuthority(partial),
        };
      })
    )
  );

  expect(result.oldTransport).toBeNull();
  expect(result.oldIdentity).toBeNull();
  expect(result.partialTransport).toBeNull();
  expect(result.partialIdentity).not.toBeNull();
});

test("wrong expected Host enters existing needs-attention policy without exposing proof", async () => {
  const status = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;
        const server = yield* startServer(options(root));

        const conn = yield* makeHostConnection({
          key: "wrong",
          name: "wrong",
          target: HostTarget.Local({ socketPath: server.socketPath }),
          identity,
          clientIdentity: { proof, expectedHostId: P.HostId.make("other-host") },
        });

        return yield* conn.changes.pipe(
          Stream.filter((state) => state.state === "needs-attention"),
          Stream.runHead
        );
      })
    )
  );

  expect(JSON.stringify(status).includes("Language identity unavailable")).toBe(true);
  expect(JSON.stringify(status).includes(Redacted.value(proof))).toBe(false);
});

test("authenticated socket preserves the Daemon's typed install reason through LanguageAccess", async () => {
  const typed = new P.LanguageError({
    reason: "conflict",
    message: "Version updates require an explicit update request",
    retryable: true,
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;

        const server = yield* startServer({
          ...options(root),
          capabilities: ["languages"],
          handlers: ServerRpcs.toLayerHandler("languages.catalog", () => Effect.fail(typed)),
        });

        const connection = yield* makeHostConnection({
          key: "upgrade",
          name: "upgrade",
          target: HostTarget.Local({ socketPath: server.socketPath }),
          identity,
          connector: socketTransport(server.socketPath),
          clientIdentity: { proof, expectedHostId: server.hostInfo.hostId },
        });

        const transport = languageTransportFor(yield* connection.awaitSession);

        if (transport === null)
          return yield* Effect.die("Missing authenticated language transport");
        const access = new LanguageAccess(transport);

        const error = yield* Effect.promise(() =>
          access.request("languages.catalog", {}).then(
            () => null,
            (cause: unknown) => Schema.decodeUnknownSync(P.LanguageError)(cause)
          )
        );

        expect(error).toEqual(typed);
        access.dispose();
      })
    )
  );
});
