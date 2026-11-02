/**
 * Loopback tests: an in-process Daemon server on a temp socket, real
 * HostConnections from @polaris/client, and `polaris bridge` as a child
 * process standing in for `ssh <host> polaris bridge`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  attachTerminal,
  type ConnectionStatus,
  type HostConnection,
  type HostConnectionOptions,
  HostTarget,
  makeHostConnection,
  spawnTransport,
  TerminalOutput,
} from "@polaris/client";
import {
  Attachment,
  AttachmentId,
  type Capability,
  Command,
  CommandId,
  CommandRejected,
  DomainEvent,
  EventEnvelope,
  FileContent,
  GitDiffSpec,
  HostStreamItem,
  NotFound,
  Sequence,
  SessionId,
  TerminalLaunch,
  WorkspaceId,
} from "@polaris/protocol";
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { AttachmentRpcsLive } from "../attachments/AttachmentRpcs.ts";
import { AttachmentStoreLive } from "../attachments/AttachmentStore.ts";
import { ClientCapabilities, DeviceLabel } from "../engine/rpc.ts";
import { GitRpcsLive } from "../git/GitRpcs.ts";
import { BlobChannel } from "../services.ts";
import { EventStore } from "../store/EventStore.ts";
import { TerminalRpcsLive } from "../terminal/TerminalRpcs.ts";
import { TerminalsLive } from "../terminal/Terminals.ts";
import { DaemonAlreadyRunning } from "./lock.ts";
import { ServerRpcs } from "./rpcs.ts";
import { startServer } from "./server.ts";
import { localEndpoint } from "@polaris/protocol/endpoint";
import { posixTest, shortTemp } from "../platform/testing.ts";

const windows = process.platform === "win32";

const MAIN = join(import.meta.dir, "..", "main.ts");

let home: string;

beforeEach(() => {
  // Short path: Unix socket paths are limited to ~104 bytes on macOS.
  home = mkdtempSync(shortTemp("plt-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// On Windows the Daemon listens on a named pipe derived from its home (ADR 0059).
const socketOf = (dir: string) => localEndpoint(dir);

/** Prints `size` a's, a newline and "done" after a moment, in the platform's shell. */
const printAs = (size: number) =>
  windows
    ? ["powershell", "-nop", "-c", `sleep -m 300; [Console]::Out.Write('a' * ${size}); ''; 'done'`]
    : ["sh", "-c", `sleep 0.3; head -c ${size} /dev/zero | tr '\\0' a; echo; echo done`];

const noStaleFile = posixTest("a pipe leaves no file; pipe.test.ts covers a name another holds");

const conPty = posixTest("a ConPTY print never ends within 20 s on windows-latest (ENG-318)");

const signalStop = posixTest(
  "SIGTERM there terminates at once; the logon task stops the Daemon over its control pipe (ADR 0060)"
);

const serverOptions = (dir: string) => ({
  socketPath: socketOf(dir),
  lockPath: join(dir, "daemon.lock"),
  root: dir,
});

const bytes = (n: number, seed: number) => {
  const out = new Uint8Array(n);

  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) % 256;

  return out;
};

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A tiny event log standing in for the store: survives server restarts. */
const makeLog = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<EventEnvelope>();
  const events: Array<EventEnvelope> = [];

  const append = Effect.suspend(() => {
    const envelope = new EventEnvelope({
      sequence: Sequence.make(events.length + 1),
      occurredAt: new Date().toISOString(),
      commandId: null,
      event: DomainEvent.cases.WorkspaceRemoved.make({
        workspaceId: WorkspaceId.make(`w${events.length + 1}`),
      }),
    });

    events.push(envelope);

    return PubSub.publish(pubsub, envelope);
  });

  const subscribeHost = (afterSequence: number | null): Stream.Stream<HostStreamItem> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const live = yield* PubSub.subscribe(pubsub);
        const upTo = events.length;

        const head: Array<HostStreamItem> =
          afterSequence === null
            ? [
                HostStreamItem.cases.Snapshot.make({
                  sequence: Sequence.make(upTo),
                  workspaces: [],
                  worktrees: [],
                  sessions: [],
                }),
              ]
            : events
                .slice(afterSequence, upTo)
                .map((envelope) => HostStreamItem.cases.Event.make({ envelope }));

        return Stream.concat(
          Stream.fromIterable([
            ...head,
            HostStreamItem.cases.Synchronized.make({ sequence: Sequence.make(upTo) }),
          ]),
          Stream.fromSubscription(live).pipe(
            Stream.filter((envelope) => envelope.sequence > upTo),
            Stream.map((envelope) => HostStreamItem.cases.Event.make({ envelope }))
          )
        );
      })
    );

  return { append, subscribeHost, events };
});

type Log = Effect.Success<typeof makeLog>;

const testHandlers = (log: Log) =>
  Layer.mergeAll(
    ServerRpcs.toLayerHandler("subscribeHost", ({ afterSequence }) =>
      log.subscribeHost(afterSequence)
    ),
    // Echo the device label hello recorded, to prove the annotation reached other handlers.
    ServerRpcs.toLayerHandler("dispatch", ({ commandId }, { client }) =>
      Effect.fail(
        new CommandRejected({
          commandId,
          reason: Context.getOrUndefined(client.annotations, DeviceLabel) ?? "none",
        })
      )
    ),
    ServerRpcs.toLayerHandler("files.read", ({ length }) =>
      Effect.gen(function* () {
        const blobs = yield* BlobChannel;
        const size = length ?? 0;
        const blobId = yield* blobs.offer(bytes(size, 7));

        return {
          size,
          mimeType: "application/octet-stream",
          content: FileContent.cases.Blob.make({ blobId }),
        };
      })
    ),
    ServerRpcs.toLayerHandler("attachments.stage", ({ name, mimeType, blobId }) =>
      Effect.gen(function* () {
        const blobs = yield* BlobChannel;
        const received = yield* Effect.orDie(blobs.take(blobId));

        return new Attachment({
          id: AttachmentId.make("a1"),
          name,
          mimeType,
          size: received.byteLength,
          hostPath: sha(received),
          width: null,
          height: null,
        });
      })
    ),
    ServerRpcs.toLayerHandler("subscribeSession", ({ sessionId }) =>
      Stream.fail(new NotFound({ what: "session", id: sessionId }))
    )
  );

const identity = {
  name: "polaris-test",
  version: "0.0.0",
  deviceLabel: "Test MacBook",
  // A windows-x64 Host answers a Client without host.any-platform with a newer protocol (ADR 0059).
  capabilities: ["blobs" as const, "files.read" as const, "host.any-platform" as const],
};

const fastPolicy = {
  initialDelayMs: 20,
  maxDelayMs: 200,
  needsAttentionRetryMs: 100,
  restartGraceMs: 5_000,
  helloTimeoutMs: 5_000,
};

const localHost = (dir: string, extra: Partial<HostConnectionOptions> = {}) =>
  makeHostConnection({
    key: "local",
    name: "Local",
    target: HostTarget.Local({ socketPath: socketOf(dir) }),
    identity,
    policy: fastPolicy,
    ...extra,
  });

const bridgeHost = (dir: string) =>
  makeHostConnection({
    key: "bridge",
    name: "Bridge",
    target: HostTarget.Ssh({ alias: "unused" }),
    identity,
    policy: fastPolicy,
    connector: spawnTransport(["bun", MAIN, "bridge"], {
      env: { ...process.env, POLARIS_HOME: dir },
    }),
  });

const waitFor = (conn: HostConnection, predicate: (s: ConnectionStatus) => boolean) =>
  conn.changes.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map((o) => Option.isSome(o) && o.value)
  );

const isEvent = HostStreamItem.isAnyOf(["Event"]);

const isBlob = FileContent.isAnyOf(["Blob"]);

const sequenceOf = HostStreamItem.match({
  Snapshot: (item) => item.sequence,
  Event: (item) => item.envelope.sequence,
  Synchronized: (item) => item.sequence,
});

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

describe("transport", () => {
  test("hello round-trip, device label and placeholders", async () => {
    const result = await run(
      Effect.gen(function* () {
        const server = yield* startServer(serverOptions(home));
        const conn = yield* localHost(home);
        const session = yield* conn.awaitSession;

        const status = yield* conn.session.pipe(
          Effect.andThen(() => SubscriptionRef.get(conn.status))
        );

        const rejected = yield* Effect.flip(
          session.client.dispatch({
            commandId: CommandId.make("c1"),
            command: Command.cases.RemoveWorkspace.make({ workspaceId: WorkspaceId.make("w1") }),
          })
        );

        const hostItems = yield* session.client
          .subscribeHost({ afterSequence: null })
          .pipe(Stream.take(2), Stream.runCollect);

        const modes = windows
          ? null
          : {
              socket: statSync(socketOf(home)).mode & 0o777,
              dir: statSync(home).mode & 0o777,
            };

        return { server, session, status, rejected, hostItems, modes };
      })
    );

    expect(result.session.host.hostId).toBe(result.server.hostInfo.hostId);
    expect<string>(result.session.host.platform).toBe(
      `${windows ? "windows" : process.platform}-${process.arch}`
    );
    expect(result.session.capabilities).toEqual(["blobs"]);
    expect(result.status.state).toBe("connected");
    // The placeholder dispatch rejects; the device label only shows with the test handlers.
    expect(result.rejected._tag).toBe("CommandRejected");
    expect(result.hostItems.map((i) => i._tag)).toEqual(["Snapshot", "Synchronized"]);

    // A pipe has no mode bits: pipe.test.ts checks its owner-only DACL.
    if (!windows) expect(result.modes).toEqual({ socket: 0o600, dir: 0o700 });
    // The socket is removed when the Daemon stops.
    expect(existsSync(socketOf(home))).toBe(false);
  });

  test("handlers see the device label from hello", async () => {
    const reason = await run(
      Effect.gen(function* () {
        const log = yield* makeLog;
        yield* startServer({ ...serverOptions(home), handlers: testHandlers(log) });
        const conn = yield* localHost(home);
        const session = yield* conn.awaitSession;

        const error = yield* Effect.flip(
          session.client.dispatch({
            commandId: CommandId.make("c1"),
            command: Command.cases.RemoveWorkspace.make({ workspaceId: WorkspaceId.make("w1") }),
          })
        );

        return error instanceof CommandRejected ? error.reason : error._tag;
      })
    );

    expect(reason).toBe("Test MacBook");
  });

  test("handlers see the Client's capabilities from hello; session.terminalCommand is served", async () => {
    const result = await run(
      Effect.gen(function* () {
        const log = yield* makeLog;

        const handlers = Layer.merge(
          testHandlers(log),
          // Echo the capabilities hello recorded, as the terminal command's argv.
          ServerRpcs.toLayerHandler("session.terminalCommand", (_, { client }) =>
            Effect.succeed(
              new TerminalLaunch({
                argv: [...(Context.getOrUndefined(client.annotations, ClientCapabilities) ?? [])],
                cwd: "/repo",
                env: {},
              })
            )
          )
        );

        yield* startServer({ ...serverOptions(home), handlers });

        const conn = yield* localHost(home, {
          identity: { ...identity, capabilities: [...identity.capabilities, "session.live-items"] },
        });

        const session = yield* conn.awaitSession;

        return yield* session.client["session.terminalCommand"]({
          sessionId: SessionId.make("s"),
        });
      })
    );

    expect(result?.argv).toEqual([
      "blobs",
      "files.read",
      "host.any-platform",
      "session.live-items",
    ]);

    // The placeholder answers NotFound; a fresh home, as a pipe's name outlives its scope.
    const fresh = mkdtempSync(join(home, "fresh-"));

    const missing = await run(
      Effect.gen(function* () {
        yield* startServer(serverOptions(fresh));
        const conn = yield* localHost(fresh);
        const session = yield* conn.awaitSession;

        return yield* Effect.flip(
          session.client["session.terminalCommand"]({ sessionId: SessionId.make("s") })
        );
      })
    );

    expect(missing._tag).toBe("NotFound");
  });

  test("streams events and moves multi-MB blobs both ways, interleaved", async () => {
    const result = await run(
      Effect.gen(function* () {
        const log = yield* makeLog;
        yield* startServer({ ...serverOptions(home), handlers: testHandlers(log) });
        const conn = yield* localHost(home);
        const session = yield* conn.awaitSession;

        const collected = yield* Effect.forkChild(
          conn.subscribeHost.pipe(Stream.filter(isEvent), Stream.take(50), Stream.runCollect)
        );

        yield* Effect.sleep(50);

        const appends = Effect.forkChild(
          Effect.forEach(
            Array.from({ length: 50 }),
            () => Effect.andThen(log.append, Effect.sleep(1)),
            {
              discard: true,
            }
          )
        );

        yield* appends;

        // While events flow, a 6 MB read and a 5 MB upload share the connection.
        const read = yield* session.client["files.read"]({
          path: "/x",
          offset: null,
          length: 6_000_000,
        });

        const readBytes = isBlob(read.content)
          ? yield* session.blobs.take(read.content.blobId)
          : null;

        const upload = bytes(5_000_000, 3);

        const staged = yield* conn.withBlob(upload, (blobId, s) =>
          s.client["attachments.stage"]({
            sessionId: null,
            workspaceId: WorkspaceId.make("w"),
            name: "big.bin",
            mimeType: "application/octet-stream",
            blobId,
          })
        );

        const events = yield* Fiber.join(collected);

        return { readBytes, staged, upload, events };
      })
    );

    expect(result.readBytes?.byteLength).toBe(6_000_000);
    expect(sha(result.readBytes!)).toBe(sha(bytes(6_000_000, 7)));
    expect(result.staged.size).toBe(5_000_000);
    expect(result.staged.hostPath).toBe(sha(result.upload));
    expect(result.events.map((e) => Number(e.envelope.sequence))).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1)
    );
  }, 20_000);

  test("many Clients connect at once and get the same stream", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const log = yield* makeLog;
        const server = yield* startServer({ ...serverOptions(home), handlers: testHandlers(log) });

        const conns = yield* Effect.forEach(Array.from({ length: 6 }), (_, i) =>
          localHost(home, { key: `c${i}` })
        );

        yield* Effect.forEach(conns, (c) => c.awaitSession, { concurrency: "unbounded" });

        const fibers = yield* Effect.forEach(conns, (c) =>
          Effect.forkChild(
            c.subscribeHost.pipe(
              Stream.filter(isEvent),
              Stream.take(10),
              Stream.map((i) => Number(i.envelope.sequence)),
              Stream.runCollect
            )
          )
        );

        yield* Effect.sleep(100);

        for (let i = 0; i < 10; i++) yield* log.append;
        const results = yield* Effect.forEach(fibers, Fiber.join);

        return { results, connections: server.connections() };
      })
    );

    expect(seen.connections).toBe(6);

    for (const r of seen.results) expect(r).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  }, 15_000);

  test("reconnects and resumes the host stream with no gaps or duplicates", async () => {
    const result = await run(
      Effect.gen(function* () {
        const log = yield* makeLog;

        const startOn = () =>
          Effect.gen(function* () {
            const scope = yield* Scope.make();
            yield* startServer({ ...serverOptions(home), handlers: testHandlers(log) }).pipe(
              Scope.provide(scope)
            );

            return scope;
          });

        let serverScope = yield* startOn();
        const conn = yield* localHost(home);
        yield* conn.awaitSession;
        const states: Array<string> = [];
        // Each connection's measured round trip, and when a drop last ended a good one.
        const latencies: Array<number | null> = [];
        const lastSeen: Array<number | null> = [];
        yield* conn.changes.pipe(
          Stream.runForEach((s) =>
            Effect.sync(() => {
              states.push(s.state);

              if (s.state === "connected") latencies.push(s.latencyMs);

              if (s.state === "reconnecting") lastSeen.push(s.lastSeenAt);
            })
          ),
          Effect.forkChild
        );

        const items = yield* Effect.forkChild(
          conn.subscribeHost.pipe(
            Stream.filter(isEvent),
            Stream.map((i) => Number(i.envelope.sequence)),
            Stream.take(90),
            Stream.runCollect
          )
        );

        yield* Effect.sleep(50);

        for (let round = 0; round < 3; round++) {
          for (let i = 0; i < 20; i++) yield* log.append;
          yield* Effect.sleep(20);
          // Kill the Daemon mid-stream; events keep landing in the store while it's down.
          yield* Scope.close(serverScope, Exit.void);

          for (let i = 0; i < 5; i++) yield* log.append;
          yield* waitFor(conn, (s) => s.state === "reconnecting");
          serverScope = yield* startOn();
          yield* waitFor(conn, (s) => s.state === "connected" && s.epoch === round + 2);

          for (let i = 0; i < 5; i++) yield* log.append;
        }

        const sequences = yield* Fiber.join(items);
        yield* Scope.close(serverScope, Exit.void);

        return { sequences, states, latencies, lastSeen, events: log.events.length };
      })
    );

    expect(result.events).toBe(90);
    expect(result.sequences).toEqual(Array.from({ length: 90 }, (_, i) => i + 1));
    expect(result.states).toContain("reconnecting");
    expect(result.states.filter((s) => s === "connected").length).toBeGreaterThanOrEqual(4);
    // Connections measure their round trip; every drop records when the Host was last seen.
    expect(result.latencies.some((ms) => ms !== null && ms >= 0 && ms < 5000)).toBe(true);
    expect(result.lastSeen.length).toBeGreaterThan(0);
    expect(result.lastSeen.every((at) => at !== null)).toBe(true);
  }, 20_000);

  test("a late subscriber paints from the cache first", async () => {
    const first = await run(
      Effect.gen(function* () {
        const log = yield* makeLog;

        for (let i = 0; i < 3; i++) yield* log.append;
        yield* startServer({ ...serverOptions(home), handlers: testHandlers(log) });
        const conn = yield* localHost(home);
        yield* conn.subscribeHost.pipe(Stream.take(2), Stream.runDrain);
        yield* log.append;

        // Nothing is subscribed now; the cache holds the snapshot at 3.
        return yield* conn.subscribeHost.pipe(Stream.take(3), Stream.runCollect);
      })
    );

    expect(first.map((i) => i._tag)).toEqual(["Snapshot", "Synchronized", "Event"]);
    expect(first.map((i) => Number(sequenceOf(i)))).toEqual([3, 3, 4]);
  }, 10_000);

  test("session streams surface NotFound", async () => {
    const error = await run(
      Effect.gen(function* () {
        const log = yield* makeLog;
        yield* startServer({ ...serverOptions(home), handlers: testHandlers(log) });
        const conn = yield* localHost(home);

        return yield* conn
          .subscribeSession(SessionId.make("nope"))
          .pipe(Stream.runDrain, Effect.flip);
      })
    );

    expect(error._tag).toBe("NotFound");
  });

  test("the lock stops a second Daemon, in process and as a process", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* startServer(serverOptions(home));
        const second = yield* startServer(serverOptions(home)).pipe(Effect.flip, Effect.scoped);

        const child = yield* Effect.promise(() =>
          runProcess(["bun", MAIN, "serve"], { POLARIS_HOME: home })
        );

        return { second, child };
      })
    );

    expect(result.second).toBeInstanceOf(DaemonAlreadyRunning);
    expect(result.child.code).toBe(75);
    expect(result.child.stderr).toContain("already running");
  }, 15_000);

  noStaleFile("takes over a stale socket left by a killed Daemon", async () => {
    const path = socketOf(home);

    const child = spawn("bun", [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"))`,
    ]);

    await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(existsSync(path)).toBe(true);

    const host = await run(
      Effect.gen(function* () {
        yield* startServer(serverOptions(home));
        const conn = yield* localHost(home);

        return (yield* conn.awaitSession).host;
      })
    );

    expect(host.hostname.length).toBeGreaterThan(0);
  });

  test("polaris bridge pipes a Client to the Daemon", async () => {
    const result = await run(
      Effect.gen(function* () {
        const log = yield* makeLog;
        yield* startServer({ ...serverOptions(home), handlers: testHandlers(log) });
        const conn = yield* bridgeHost(home);
        const session = yield* conn.awaitSession;

        const read = yield* session.client["files.read"]({
          path: "/x",
          offset: null,
          length: 3_000_000,
        });

        const got = isBlob(read.content) ? yield* session.blobs.take(read.content.blobId) : null;

        const staged = yield* conn.withBlob(bytes(2_000_000, 9), (blobId, s) =>
          s.client["attachments.stage"]({
            sessionId: null,
            workspaceId: WorkspaceId.make("w"),
            name: "b",
            mimeType: "x/y",
            blobId,
          })
        );

        return { host: session.host, got, staged };
      })
    );

    expect(result.got && sha(result.got)).toBe(sha(bytes(3_000_000, 7)));
    expect(result.staged.hostPath).toBe(sha(bytes(2_000_000, 9)));
  }, 15_000);

  test("no Daemon behind the bridge is Needs Attention, and it recovers", async () => {
    const result = await run(
      Effect.gen(function* () {
        const conn = yield* bridgeHost(home);
        yield* waitFor(conn, (s) => s.state === "needs-attention");
        const status = yield* SubscriptionRef.get(conn.status);
        yield* startServer(serverOptions(home));
        yield* conn.retryNow;
        yield* waitFor(conn, (s) => s.state === "connected");

        return status;
      })
    );

    expect(result.failure?.reason).toBe("daemon-not-running");
  }, 15_000);

  test("another module's handlers get their connection's BlobChannel (git.diff)", async () => {
    const repo = join(home, "repo");

    const git = (...args: Array<string>) => {
      const r = Bun.spawnSync(["git", "-C", repo, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });

      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };

    Bun.spawnSync(["git", "init", "-q", repo]);
    await Bun.write(join(repo, "big.txt"), "a\n".repeat(400_000));
    git("add", ".");
    git("commit", "-qm", "init");
    await Bun.write(join(repo, "big.txt"), "b\n".repeat(400_000));

    const diff = await run(
      Effect.gen(function* () {
        yield* startServer({ ...serverOptions(home), handlers: GitRpcsLive });
        const conn = yield* localHost(home);
        const session = yield* conn.awaitSession;

        const result = yield* session.client["git.diff"]({
          cwd: repo,
          spec: GitDiffSpec.cases.WorkingTree.make({ base: null }),
        });

        const text = new TextDecoder().decode(yield* session.blobs.take(result.blobId));

        return { result, text };
      })
    );

    // (`files` is not checked: git/diff.ts counts over an ArrayBuffer and reports 0; see README.)
    expect(diff.text.length).toBe(diff.result.size);
    expect(diff.text).toContain("+b");
  }, 20_000);

  test("attachments.stage streams an upload to disk through the socket", async () => {
    const payload = bytes(3 * 1024 * 1024 + 17, 5);

    const staged = await run(
      Effect.gen(function* () {
        yield* startServer({
          ...serverOptions(home),
          handlers: AttachmentRpcsLive.pipe(
            Layer.provide(AttachmentStoreLive({ root: join(home, "staging") }))
          ),
        });
        const conn = yield* localHost(home);
        yield* conn.awaitSession;

        return yield* conn.withBlob(payload, (blobId, s) =>
          s.client["attachments.stage"]({
            sessionId: null,
            workspaceId: WorkspaceId.make("w1"),
            name: "big.bin",
            mimeType: "application/octet-stream",
            blobId,
          })
        );
      })
    );

    expect(staged.size).toBe(payload.byteLength);
    expect(sha(new Uint8Array(await Bun.file(staged.hostPath).arrayBuffer()))).toBe(sha(payload));
  }, 20_000);

  conPty(
    "terminal output is the same as raw bytes (terminal.binary) and base64",
    async () => {
      const size = 300_000;

      const texts = await run(
        Effect.gen(function* () {
          yield* startServer({
            ...serverOptions(home),
            handlers: TerminalRpcsLive.pipe(
              Layer.provide(Layer.merge(TerminalsLive, EventStore.layerSqlite(":memory:")))
            ),
            capabilities: ["terminal", "terminal.binary"],
          });
          const conn = yield* localHost(home);
          const session = yield* conn.awaitSession;

          const read = (capabilities: ReadonlyArray<Capability>) =>
            Effect.gen(function* () {
              const { terminalId } = yield* session.client["terminal.open"]({
                cwd: home,
                cols: 80,
                rows: 24,
                argv: printAs(size),
              });

              let text = "";
              const decoder = new TextDecoder();
              let exit: number | null | undefined;
              yield* attachTerminal({ ...session, capabilities }, terminalId).pipe(
                Stream.runForEach((item) =>
                  Effect.sync(() =>
                    TerminalOutput.$match(item, {
                      Output: (output) => {
                        text += decoder.decode(output.data, { stream: true });
                      },
                      Exit: (ended) => {
                        exit = ended.code;
                      },
                    })
                  )
                )
              );

              return { text, exit };
            });

          return [yield* read(["terminal.binary"]), yield* read([])];
        })
      );

      for (const { text, exit } of texts) {
        expect(exit).toBe(0);
        const count = text.split("a").length - 1;

        expect(count).toBe(size);
        expect(text).toContain("done");
      }
    },
    20_000
  );

  signalStop(
    "polaris serve as a process: pid file, bridge, clean shutdown",
    async () => {
      const env = { ...process.env, POLARIS_HOME: home };
      const daemon = spawn("bun", [MAIN, "serve"], { env, stdio: "ignore" });

      try {
        for (let i = 0; i < 100 && !existsSync(join(home, "daemon.pid")); i++) await Bun.sleep(50);

        const host = await run(
          Effect.gen(function* () {
            const conn = yield* bridgeHost(home);

            return (yield* conn.awaitSession).host;
          })
        );

        expect(host.daemonVersion.length).toBeGreaterThan(0);
        expect(Number((await Bun.file(join(home, "daemon.pid")).text()).trim())).toBe(daemon.pid!);
        expect(Number((await Bun.file(join(home, "daemon.lock")).text()).trim())).toBe(daemon.pid!);
      } finally {
        daemon.kill("SIGTERM");
        await new Promise((resolve) => daemon.once("exit", resolve));
      }

      for (const file of ["daemon.sock", "daemon.lock", "daemon.pid"])
        expect(existsSync(join(home, file))).toBe(false);
    },
    20_000
  );
});

const runProcess = (argv: Array<string>, env: Record<string, string>) =>
  new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const [command, ...args] = argv;
    const child: ChildProcess = spawn(command!, args, { env: { ...process.env, ...env } });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
