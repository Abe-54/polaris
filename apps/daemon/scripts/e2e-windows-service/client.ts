/**
 * The Client side of `e2e-windows-service.ts`, bundled and run on the Windows
 * Host: a real `@polaris/client` connection to the Daemon's pipe that logs every
 * Connection State change and, on each connection, the Agent Sessions the Host
 * reports. With `--seed` it registers a Workspace and starts one Agent Session
 * on its first connection. It ends when `<stop file>` appears.
 *
 *   bun client.js <polaris home> <log file> <stop file> [--seed <workspace dir>]
 */
import { appendFileSync, existsSync } from "node:fs";
import { type DaemonClient, HostTarget, makeHostConnection } from "@polaris/client";
import {
  Capability,
  Command,
  CommandId,
  HostStreamItem,
  SessionId,
  SessionPlacement,
  type WorkspaceId,
} from "@polaris/protocol";
import { localEndpoint } from "@polaris/protocol/endpoint";
import { Effect, Option, Redacted, Stream } from "effect";

const [home, logFile, stopFile, flag, seedDir] = process.argv.slice(2);

if (home === undefined || logFile === undefined || stopFile === undefined) {
  console.error("usage: client.js <polaris home> <log file> <stop file> [--seed <dir>]");
  process.exit(2);
}

/** One JSON line: what happened (`ev`) and its details. */
const log = <Entry extends { readonly ev: string }>(entry: Entry) =>
  appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

const program = Effect.gen(function* () {
  const connection = yield* makeHostConnection({
    key: "local",
    name: "Windows e2e",
    target: HostTarget.Local({ socketPath: localEndpoint(home, "win32") }),
    identity: {
      name: "polaris-e2e",
      version: "0.0.0",
      deviceLabel: "e2e",
      capabilities: Capability.literals,
      // As the Desktop App: the fresh home enrols it, so it may start a session (ADR 0100).
      userKey: Redacted.make("e".repeat(64)),
    },
    policy: { initialDelayMs: 100, maxDelayMs: 1000, restartGraceMs: 30_000 },
  });

  let seeded = flag !== "--seed";
  let lastEpoch = -1;

  const onConnected = Effect.fnUntraced(function* () {
    const live = yield* connection.awaitSession;

    if (!seeded && seedDir !== undefined) {
      seeded = true;
      yield* live.client.dispatch({
        commandId: CommandId.make(`e2e-ws-${Date.now()}`),
        command: Command.cases.RegisterWorkspace.make({ path: seedDir, name: "e2e" }),
      });

      const first = yield* snapshotOf(live.client);

      const workspaceId: WorkspaceId | undefined = first?.workspaces.find(
        (w) => w.name === "e2e"
      )?.id;

      if (workspaceId !== undefined) {
        const started = yield* live.client
          .dispatch({
            commandId: CommandId.make(`e2e-session-${Date.now()}`),
            command: Command.cases.StartSession.make({
              sessionId: SessionId.make("e2e-session-1"),
              workspaceId,
              harness: "codex",
              placement: SessionPlacement.cases.InPlace.make({}),
              permissionMode: "supervised",
              model: null,
              effort: null,
              prompt: "say hello",
              attachments: [],
            }),
          })
          .pipe(Effect.result);

        log({ ev: "seeded", workspaceId, started: String(started) });
      }
    }

    const snapshot = yield* snapshotOf(live.client);
    log({
      ev: "snapshot",
      epoch: live.epoch,
      workspaces: snapshot?.workspaces.map((w) => w.path) ?? [],
      sessions: snapshot?.sessions.map((s) => ({ id: s.session.id, state: s.session.state })) ?? [],
    });
  });

  yield* connection.changes.pipe(
    Stream.runForEach((status) =>
      Effect.gen(function* () {
        log({
          ev: "status",
          state: status.state,
          epoch: status.epoch,
          version: status.host?.daemonVersion ?? null,
          startedAt: status.host?.startedAt ?? null,
          previousStop: status.host?.previousStop ?? null,
          failure: status.failure?.reason ?? null,
        });

        if (status.state === "connected" && status.epoch !== lastEpoch) {
          lastEpoch = status.epoch;
          yield* onConnected().pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log({ ev: "error", cause: String(cause) }))
            )
          );
        }
      })
    ),
    Effect.forkScoped
  );

  while (!existsSync(stopFile)) yield* Effect.sleep(200);
  log({ ev: "done" });
});

const snapshotOf = (client: DaemonClient) =>
  client.subscribeHost({ afterSequence: null }).pipe(
    Stream.filter(HostStreamItem.guards.Snapshot),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined)
  );

await Effect.runPromise(Effect.scoped(program));

process.exit(0);
