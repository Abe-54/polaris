import { expect } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { connectRpc, socketTransport } from "@polaris/client";
import * as P from "@polaris/protocol";
import { Deferred, Effect, Fiber, Layer, Redacted, type Scope } from "effect";
import { EventStore } from "../../store/EventStore.ts";
import { BlobChannel } from "../../services.ts";
import { startServer } from "../../transport/server.ts";
import { HostPreviewMedia, createHostPreviewMedia } from "./index.ts";
import { PreviewMediaRpc } from "./rpc.ts";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const test = posixTest(
  "Host media reads need descriptor-relative NOFOLLOW opens and POSIX paths (ENG-296)"
);

const proof = Redacted.make("c".repeat(64));

const other = Redacted.make("d".repeat(64));

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=",
  "base64"
);

const hello = (languageProof?: Redacted.Redacted<unknown>) => {
  const input = {
    clientName: "fake-media",
    clientVersion: "0",
    deviceLabel: "fixture",
    capabilities: [],
  };

  return languageProof === undefined ? input : { ...input, languageProof };
};

const fixture = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => newTempDir("pl-h1-rpc-", { short: true })),
    (path) =>
      Effect.sync(() => {
        removeTempDir(path);
        expect(existsSync(path)).toBe(false);
      })
  );

  const workspacePath = join(root, "workspace");
  const foreignPath = join(root, "foreign");
  const worktreePath = join(root, "worktree");

  for (const path of [workspacePath, foreignPath, worktreePath]) {
    mkdirSync(path);
    writeFileSync(join(path, "doc.md"), "![one](one.png)");
    writeFileSync(join(path, "one.png"), png);
  }

  const workspaceId = P.WorkspaceId.make("media-workspace");
  const foreignId = P.WorkspaceId.make("media-foreign");
  const worktreeId = P.WorktreeId.make("media-worktree");
  const store = yield* EventStore;

  const workspace = (id: P.WorkspaceId, path: string) =>
    new P.Workspace({
      id,
      path,
      name: "fixture",
      isGitRepo: false,
      worktreeRoot: join(root, "trees"),
      hidden: false,
      registeredAt: new Date().toISOString(),
    });

  yield* store.commit({
    commandId: null,
    decide: () =>
      Effect.succeed([
        P.DomainEvent.cases.WorkspaceRegistered.make({
          workspace: workspace(workspaceId, workspacePath),
        }),
        P.DomainEvent.cases.WorkspaceRegistered.make({
          workspace: workspace(foreignId, foreignPath),
        }),
        P.DomainEvent.cases.WorktreeDetected.make({
          worktree: new P.Worktree({
            id: worktreeId,
            workspaceId,
            path: worktreePath,
            branch: null,
            head: "fixture",
            createdBySessionId: null,
            isMain: false,
          }),
        }),
      ]),
  });
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const finished = yield* Deferred.make<void>();
  let hold = false;
  let offers = 0;
  const actual = createHostPreviewMedia();

  const media = HostPreviewMedia.of({
    read: (input) =>
      Effect.gen(function* () {
        const blobs = yield* BlobChannel;

        return yield* actual.read(input).pipe(
          Effect.provideService(BlobChannel, {
            ...blobs,
            offer: (bytes) =>
              Effect.andThen(
                Effect.sync(() => {
                  offers++;
                }),
                blobs.offer(bytes)
              ),
          })
        );
      }).pipe(Effect.ensuring(Deferred.succeed(finished, undefined))),
  });

  const heldStore = EventStore.of({
    ...store,
    model: Effect.gen(function* () {
      if (hold) {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
      }

      return yield* store.model;
    }),
  });

  const handlers = PreviewMediaRpc.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(EventStore)(heldStore), Layer.succeed(HostPreviewMedia)(media))
    )
  );

  const server = yield* startServer({
    root,
    socketPath: join(root, "d.sock"),
    lockPath: join(root, "d.lock"),
    handlers,
  }).pipe(Effect.provideService(EventStore, heldStore));

  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));

  const transport = yield* socketTransport(server.socketPath);
  const rpc = yield* connectRpc(transport);
  const checkout = P.LanguageCheckout.cases.Workspace.make({ workspaceId, path: workspacePath });

  const input = {
    checkout,
    documentPath: join(workspacePath, "doc.md"),
    relativePath: "one.png",
    maxBytes: 10485760,
  };

  return {
    rpc,
    transport,
    server,
    input,
    workspaceId,
    foreignId,
    worktreeId,
    worktreePath,
    foreignPath,
    entered,
    release,
    finished,
    setHold: () => {
      hold = true;
    },
    offers: () => offers,
  };
});

const run = <A, E>(program: Effect.Effect<A, E, EventStore | Scope.Scope>) =>
  Effect.runPromise(
    program.pipe(Effect.scoped, Effect.provide(EventStore.layerSqlite(":memory:")))
  );

test("actual media socket: absent identity denies before Blob; valid raster needs no execution trust", async () => {
  await run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const old = yield* connectRpc(yield* socketTransport(f.server.socketPath));
      yield* old.client.hello(hello());
      const denied = yield* Effect.flip(old.client["languages.preview.media"](f.input));
      expect(denied).toBeInstanceOf(P.LanguageError);
      expect(f.offers()).toBe(0);
      const reply = yield* f.rpc.client.hello(hello(proof));
      expect(reply.capabilities).not.toContain("languages");
      const media = yield* f.rpc.client["languages.preview.media"](f.input);
      expect(media.mimeType).toBe("image/png");
      expect(media.bytes).toBe(png.length);
      expect(Buffer.from(yield* f.rpc.blobs.take(media.blobId))).toEqual(png);
      expect(f.offers()).toBe(1);
    })
  );
});

test("actual media socket: authoritative registry rejects forged roots, unknown IDs and Worktree owner mismatch", async () => {
  await run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.rpc.client.hello(hello(proof));

      const checkouts = [
        P.LanguageCheckout.cases.Workspace.make({
          workspaceId: f.workspaceId,
          path: f.foreignPath,
        }),
        P.LanguageCheckout.cases.Workspace.make({
          workspaceId: P.WorkspaceId.make("unregistered"),
          path: f.foreignPath,
        }),
        P.LanguageCheckout.cases.Worktree.make({
          workspaceId: f.foreignId,
          worktreeId: f.worktreeId,
          path: f.worktreePath,
        }),
        P.LanguageCheckout.cases.Worktree.make({
          workspaceId: f.workspaceId,
          worktreeId: P.WorktreeId.make("unregistered"),
          path: f.worktreePath,
        }),
      ];

      for (const checkout of checkouts) {
        const error = yield* Effect.flip(
          f.rpc.client["languages.preview.media"]({ ...f.input, checkout })
        );

        expect(error).toBeInstanceOf(P.LanguageError);
        expect(f.offers()).toBe(0);
      }

      const checkout = P.LanguageCheckout.cases.Worktree.make({
        workspaceId: f.workspaceId,
        worktreeId: f.worktreeId,
        path: f.worktreePath,
      });

      const media = yield* f.rpc.client["languages.preview.media"]({
        ...f.input,
        checkout,
        documentPath: join(f.worktreePath, "doc.md"),
      });

      expect(Buffer.from(yield* f.rpc.blobs.take(media.blobId))).toEqual(png);
      expect(f.offers()).toBe(1);
    })
  );
});

for (const mode of ["disconnect", "identity-switch"] as const) {
  test(`actual media socket: ${mode} during awaited registry read never offers Blob`, async () => {
    await run(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.rpc.client.hello(hello(proof));
        f.setHold();

        const pending = yield* f.rpc.client["languages.preview.media"](f.input).pipe(
          Effect.exit,
          Effect.forkScoped
        );

        yield* Deferred.await(f.entered);

        if (mode === "disconnect") yield* f.transport.close;
        else
          expect(yield* Effect.flip(f.rpc.client.hello(hello(other)))).toBeInstanceOf(
            P.LanguageIdentityError
          );
        yield* Deferred.succeed(f.release, undefined);
        yield* Deferred.await(f.finished);
        yield* Fiber.interrupt(pending);
        expect(f.offers()).toBe(0);
        const replacement = yield* connectRpc(yield* socketTransport(f.server.socketPath));
        yield* replacement.client.hello(hello(proof));
        const media = yield* replacement.client["languages.preview.media"](f.input);
        expect(Buffer.from(yield* replacement.blobs.take(media.blobId))).toEqual(png);
        expect(f.offers()).toBe(1);
      })
    );
  });
}
