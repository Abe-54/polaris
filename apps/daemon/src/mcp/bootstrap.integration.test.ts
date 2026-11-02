import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { connectRpc, socketTransport } from "@polaris/client";
import { localEndpoint } from "@polaris/protocol/endpoint";
import {
  Command,
  CommandId,
  DomainEvent,
  HostStreamItem,
  SessionId,
  SessionPlacement,
  SessionStreamItem,
} from "@polaris/protocol";
import { Effect, Fiber, Option, Stream } from "effect";

test("a real idle Daemon lazily binds plain Codex and Claude Sessions and starts their Constellations", async () => {
  const home = newTempDir("polaris-bootstrap-", { short: true });

  const daemon = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../main.ts"), "serve", "--foreground"],
    {
      env: {
        ...process.env,
        POLARIS_HOME: home,
        POLARIS_HOST_SOCKET: localEndpoint(home),
        POLARIS_SESSION_ID: undefined,
        POLARIS_BINARY: undefined,
        POLARIS_BENCH_HARNESS: "1",
      },
      stdout: "pipe",
      stderr: "ignore",
    }
  );

  try {
    const reader = daemon.stdout.getReader();
    let logs = "";

    while (!logs.includes("Daemon listening on")) {
      const chunk = await reader.read();

      if (chunk.done) throw new Error(`Daemon stopped before listening: ${logs}`);
      logs += new TextDecoder().decode(chunk.value);
    }

    reader.releaseLock();
    expect(existsSync(join(home, "mcp.sqlite"))).toBe(false);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* socketTransport(localEndpoint(home));
          const { client } = yield* connectRpc(transport);

          yield* client.hello({
            clientName: "bootstrap-test",
            clientVersion: "0",
            deviceLabel: "test",
            capabilities: ["constellation"],
          });

          const dispatch = (command: Command) =>
            client.dispatch({ commandId: CommandId.make(randomUUID()), command });

          yield* dispatch(Command.cases.RegisterWorkspace.make({ path: home, name: "Probe" }));

          const host = yield* client
            .subscribeHost({ afterSequence: null })
            .pipe(Stream.filter(HostStreamItem.guards.Snapshot), Stream.runHead);

          const workspace = Option.getOrThrow(host).workspaces.find((w) => w.name === "Probe")!;

          for (const harness of ["codex", "claude"] as const) {
            const sessionId = SessionId.make(randomUUID());

            const completed = yield* client.subscribeHost({ afterSequence: null }).pipe(
              Stream.filter(
                (item) =>
                  HostStreamItem.guards.Event(item) &&
                  DomainEvent.guards.SessionStateChanged(item.envelope.event) &&
                  item.envelope.event.sessionId === sessionId &&
                  item.envelope.event.state === "idle"
              ),
              Stream.runHead,
              Effect.forkScoped
            );

            yield* dispatch(
              Command.cases.StartSession.make({
                sessionId,
                workspaceId: workspace.id,
                harness,
                placement: SessionPlacement.cases.InPlace.make({}),
                permissionMode: "supervised",
                model: null,
                effort: null,
                prompt: "create a test constellation",
                attachments: [],
              })
            );

            yield* Fiber.join(completed);

            const snapshot = yield* client
              .subscribeSession({ sessionId, afterSequence: null, turnLimit: null })
              .pipe(Stream.filter(SessionStreamItem.guards.Snapshot), Stream.runHead);

            const session = Option.getOrThrow(snapshot);
            const items = session.turns.flatMap((turn) => turn.items);
            expect(items).toHaveLength(1);
            expect(items[0]).toMatchObject({
              name: "mcp__polaris__plan",
              status: "completed",
              input: {
                start: { name: "Test constellation", workspaceId: workspace.id },
                operations: [],
              },
            });

            const updated = yield* client
              .subscribeHost({ afterSequence: null })
              .pipe(Stream.filter(HostStreamItem.guards.Snapshot), Stream.runHead);

            expect(
              Option.getOrThrow(updated).constellations?.some(
                (graph) => graph.leadSessionId === sessionId
              )
            ).toBe(true);
          }
        })
      ).pipe(Effect.timeout(10000))
    );

    expect(existsSync(join(home, "mcp.sqlite"))).toBe(true);
  } finally {
    daemon.kill("SIGTERM");
    await daemon.exited;
    removeTempDir(home);
  }
}, 20000);
