import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connectRpc, socketTransport } from "@polaris/client";
import {
  CommandId,
  DeveloperModeError,
  type DeveloperMode,
  DomainEvent,
  Workspace,
  WorkspaceId,
} from "@polaris/protocol";
import { Duration, Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import { shortTemp } from "../platform/testing.ts";
import { EventStore } from "../store/EventStore.ts";
import { startServer } from "../transport/server.ts";
import { developerModeLayer } from "./live.ts";
import { DeveloperModeRpcHandlers } from "./rpc.ts";
import { DeveloperModeState } from "./service.ts";

const temporary = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(shortTemp("pl-dm-"))),
  (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true }))
);

const hello = { clientName: "fake", clientVersion: "0", deviceLabel: "test", capabilities: [] };

const workspace = (id: string, path: string, registeredAt: string) =>
  Workspace.make({
    id: WorkspaceId.make(id),
    path,
    name: id,
    isGitRepo: true,
    worktreeRoot: `${path}.worktrees`,
    hidden: false,
    registeredAt,
  });

const register = (ws: Workspace) =>
  Effect.flatMap(EventStore, (store) =>
    store.commit({
      commandId: CommandId.make(`register-${ws.id}`),
      decide: () => Effect.succeed([DomainEvent.cases.WorkspaceRegistered.make({ workspace: ws })]),
    })
  );

const repo = (root: string, name: string, remote: string) => {
  const path = join(root, name);
  mkdirSync(path);
  execFileSync("git", ["init", "--quiet", path]);
  execFileSync("git", ["-C", path, "remote", "add", "origin", remote]);

  return path;
};

/** A Daemon serving the real handlers over `file`, with its own in-memory store. */
const daemon = Effect.fnUntraced(function* (
  root: string,
  file: string,
  options: { fromSource?: boolean; database?: string } = {}
) {
  const services = yield* Layer.build(
    developerModeLayer({ file, fromSource: options.fromSource ?? false }).pipe(
      Layer.provideMerge(EventStore.layerSqlite(options.database ?? ":memory:"))
    )
  );

  const server = yield* startServer({
    root,
    socketPath: join(root, "d.sock"),
    lockPath: join(root, "d.lock"),
    handlers: DeveloperModeRpcHandlers.pipe(Layer.provide(Layer.succeedContext(services))),
  });

  const connect = Effect.gen(function* () {
    const connection = yield* connectRpc(yield* socketTransport(server.socketPath));
    yield* connection.client.hello(hello);

    return connection.client;
  });

  return { services, connect };
});

/** The first value of `stream` that passes `check`, failing after five seconds. */
const until = (
  stream: Stream.Stream<DeveloperMode, unknown>,
  check: (m: DeveloperMode) => boolean
) =>
  stream.pipe(
    Stream.filter(check),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.timeout(Duration.seconds(5))
  );

const run = <A>(body: Effect.Effect<A, unknown, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(body));

test("the stored setting survives a Daemon restart, and a corrupt file reads as off", () =>
  run(
    Effect.gen(function* () {
      const root = yield* temporary;
      const file = join(root, "developer-mode.json");

      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* (yield* daemon(join(root, "a"), file)).connect;

          return yield* client["developerMode.set"]({ enabled: true });
        })
      );

      expect(first.effective).toBe(true);

      const restarted = yield* (yield* daemon(join(root, "b"), file)).connect;
      const after = yield* restarted["developerMode.get"]({});

      expect(after.stored).toBe(true);
      expect(after.effective).toBe(true);

      yield* Effect.promise(() => Bun.write(file, "{not json"));
      const corrupt = yield* (yield* daemon(join(root, "c"), file)).connect;

      expect((yield* corrupt["developerMode.get"]({})).stored).toBe(false);
    })
  ));

test("a lease turns Developer Mode on without writing the stored setting, and ends with its connection", () =>
  run(
    Effect.gen(function* () {
      const root = yield* temporary;
      const file = join(root, "developer-mode.json");
      const host = yield* daemon(join(root, "d"), file);
      const watcher = yield* host.connect;
      const watch = watcher["developerMode.watch"]({});

      expect(yield* until(watch, () => true)).toMatchObject({ effective: false, leases: 0 });

      const devScope = yield* Scope.make();
      const dev = yield* host.connect.pipe(Scope.provide(devScope));
      yield* Stream.runDrain(dev["developerMode.lease"]({})).pipe(Effect.forkIn(devScope));

      const on = yield* until(watch, (m) => m.leases === 1);
      expect(on).toMatchObject({ stored: false, effective: true });

      // The Mobile App's view of the stored setting stays off while Polaris Dev holds the lease.
      expect((yield* watcher["developerMode.get"]({})).stored).toBe(false);

      yield* Scope.close(devScope, Exit.void);
      const off = yield* until(watch, (m) => m.leases === 0);

      expect(off.effective).toBe(false);

      const restarted = yield* (yield* daemon(join(root, "e"), file)).connect;
      expect((yield* restarted["developerMode.get"]({})).stored).toBe(false);
    })
  ));

test("a Daemon run from source is effective with the setting off and no lease", () =>
  run(
    Effect.gen(function* () {
      const root = yield* temporary;
      const host = yield* daemon(root, join(root, "developer-mode.json"), { fromSource: true });
      const mode = yield* (yield* host.connect)["developerMode.get"]({});

      expect(mode).toMatchObject({ stored: false, leases: 0, fromSource: true, effective: true });
    })
  ));

test("the Polaris Workspace is found by its git remote, and an override persists until cleared", () =>
  run(
    Effect.gen(function* () {
      const root = yield* temporary;
      const file = join(root, "developer-mode.json");
      const other = repo(root, "other", "git@github.com:someone/app.git");
      const polaris = repo(root, "polaris", "git@github.com:luxdotdev/polaris.git");
      const host = yield* daemon(join(root, "f"), file);
      const client = yield* host.connect;
      const watch = client["developerMode.watch"]({});

      yield* Effect.provide(
        register(workspace("other", other, "2026-01-01T00:00:00Z")),
        host.services
      );
      yield* Effect.provide(
        register(workspace("polaris", polaris, "2026-01-02T00:00:00Z")),
        host.services
      );

      const found = yield* until(watch, (m) => m.polarisWorkspaceId !== null);
      expect(found).toMatchObject({
        polarisWorkspaceId: "polaris",
        polarisWorkspaceSource: "remote",
      });

      const unknown = yield* Effect.flip(
        client["developerMode.setWorkspace"]({ workspaceId: WorkspaceId.make("missing") })
      );

      expect(unknown).toBeInstanceOf(DeveloperModeError);
      expect(unknown).toMatchObject({ reason: "unknown-workspace" });

      const chosen = yield* client["developerMode.setWorkspace"]({
        workspaceId: WorkspaceId.make("other"),
      });

      expect(chosen).toMatchObject({
        polarisWorkspaceId: "other",
        polarisWorkspaceSource: "override",
      });

      const state = yield* Effect.provide(Effect.service(DeveloperModeState), host.services);
      expect((yield* state.current).polarisWorkspaceId).toBe(WorkspaceId.make("other"));

      const cleared = yield* client["developerMode.setWorkspace"]({ workspaceId: null });
      expect(cleared).toMatchObject({
        polarisWorkspaceId: "polaris",
        polarisWorkspaceSource: "remote",
      });
    })
  ));

test("the override is read back after a restart", () =>
  run(
    Effect.gen(function* () {
      const root = yield* temporary;
      const file = join(root, "developer-mode.json");
      const database = join(root, "state.sqlite");
      const app = repo(root, "app", "https://github.com/someone/app");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* daemon(join(root, "g"), file, { database });
          yield* Effect.provide(
            register(workspace("app", app, "2026-01-01T00:00:00Z")),
            host.services
          );
          const client = yield* host.connect;
          yield* client["developerMode.setWorkspace"]({ workspaceId: WorkspaceId.make("app") });
        })
      );

      const restarted = yield* daemon(join(root, "h"), file, { database });
      const watch = (yield* restarted.connect)["developerMode.watch"]({});
      const mode = yield* until(watch, (m) => m.polarisWorkspaceId !== null);

      expect(mode).toMatchObject({ polarisWorkspaceId: "app", polarisWorkspaceSource: "override" });
    })
  ));
