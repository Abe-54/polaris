/** macOS source-Daemon smoke; discovers only this disposable Daemon's MCP listener with lsof. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { connectRpc, socketTransport } from "../../../../packages/client/src/index.ts";
import {
  Command,
  CommandId,
  ConstellationId,
  DomainEvent,
  HostStreamItem,
  LanguageCheckout,
  Profile,
  ProfileDetail,
  SessionId,
  SessionPlacement,
} from "../../../../packages/protocol/src/index.ts";
import { Effect, Fiber, Option, Redacted, Schema, Stream } from "effect";
import { launchDaemon, awaitReady } from "../../../../packages/bench/src/daemon.ts";
import { McpTokens } from "../../../../apps/daemon/src/mcp/tokens.ts";
import { McpBinding } from "../../../../apps/daemon/src/mcp/binding.ts";
import {
  createExecutionTrust,
  createFileTrustRepository,
  trustDirectory,
} from "../../../../apps/daemon/src/languages/trust/index.ts";
import { cpuWork } from "../../../../apps/daemon/src/traces/profiles/testing.ts";
import { profileDirectory } from "../../../../apps/daemon/src/traces/profiles/workerClient.ts";

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Server did not become ready");
    await Bun.sleep(25);
  }
};
const ToolResult = Schema.Struct({
  result: Schema.Struct({ structuredContent: Schema.Struct({ profile: Profile }) }),
});

for (const binary of ["node", "bun"]) {
  const home = await mkdtemp("/tmp/p4-daemon-");
  const workspace = await realpath(await mkdtemp("/tmp/p4-server-"));
  const ready = join(workspace, "ready");
  const script = join(workspace, "server.cjs");
  await mkdir(join(workspace, "package"));
  await writeFile(
    script,
    `${cpuWork} require("http").createServer((_,res)=>res.end("ok")).listen(0, "127.0.0.1",()=>require("fs").writeFileSync(${JSON.stringify(ready)},"ready"));`
  );
  const daemon = await launchDaemon({ binary: null, home, env: { POLARIS_TRACE_PORT: "0" } });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* awaitReady(daemon);
          const { client } = yield* connectRpc(yield* socketTransport(daemon.socketPath));
          const hello = yield* client.hello({
            clientName: "profile-smoke",
            clientVersion: "0",
            deviceLabel: "test",
            capabilities: [],
            languageProof: Redacted.make("f".repeat(64)),
          });
          const dispatch = (command: Command) =>
            client.dispatch({ commandId: CommandId.make(crypto.randomUUID()), command });
          yield* dispatch(
            Command.cases.RegisterWorkspace.make({ path: workspace, name: "Profile smoke" })
          );
          const snapshot = yield* client
            .subscribeHost({ afterSequence: null })
            .pipe(Stream.filter(HostStreamItem.guards.Snapshot), Stream.runHead);
          const registered = Option.getOrThrow(snapshot).workspaces.find(
            (w) => w.path === workspace
          )!;
          const checkout = LanguageCheckout.cases.Workspace.make({
            workspaceId: registered.id,
            path: workspace,
          });
          yield* Effect.promise(() =>
            createExecutionTrust({
              hostId: hello.host.hostId,
              registry: async () => ({ checkout, workspacePath: workspace }),
              repository: createFileTrustRepository(trustDirectory(home)),
              authorizeGrant: async () => {},
            }).set(checkout, true, 0)
          );
          const sessionId = SessionId.make(crypto.randomUUID());
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
              workspaceId: registered.id,
              harness: "codex",
              placement: SessionPlacement.cases.InPlace.make({}),
              permissionMode: "supervised",
              model: null,
              effort: null,
              prompt: 'bench:{"items":1}',
              attachments: [],
            })
          );
          yield* Fiber.join(completed);
          const token = yield* Effect.scoped(
            Effect.flatMap(McpTokens, (tokens) =>
              tokens.issue(
                McpBinding.cases.Plain.make({
                  sessionId,
                  workspaceId: registered.id,
                  constellationId: ConstellationId.make(crypto.randomUUID()),
                })
              )
            ).pipe(Effect.provide(McpTokens.layer(join(home, "mcp.sqlite"))))
          );
          yield* Effect.promise(async () => {
            const listed = Bun.spawnSync([
              "lsof",
              "-nP",
              "-a",
              "-p",
              String(daemon.pid),
              "-iTCP",
              "-sTCP:LISTEN",
              "-Fn",
            ]);
            const ports = [...listed.stdout.toString().matchAll(/n127\.0\.0\.1:(\d+)/g)].map(
              (m) => m[1]
            );
            let endpoint = "";
            for (const port of ports) {
              const url = `http://127.0.0.1:${port}/mcp/${token}`;
              const response = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "initialize",
                  params: { protocolVersion: "2025-11-25" },
                }),
              });
              const responseText = await response.text();
              if (responseText.includes('"serverInfo":{"name":"polaris"'))
                endpoint = url;
            }
            assert.ok(endpoint, "The disposable Daemon exposes its authenticated MCP listener");
            const call = async (
              args: { command: string[]; waitSeconds: number } | { process: number }
            ) => {
              const response = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  method: "tools/call",
                  params: { name: "profile", arguments: args },
                }),
              });
              return Schema.decodeUnknownSync(ToolResult)(await response.json()).result
                .structuredContent.profile;
            };
            const original = await call({ command: [binary, script], waitSeconds: 1 });
            assert.equal(original.status, "recording");
            await until(() => existsSync(ready));
            await rm(ready);
            const next = await call({ process: original.pid });
            assert.equal(next.status, "recording");
            const ended = await Effect.runPromise(
              client["profiles.get"]({ sessionId, profileId: original.id })
            );
            assert.equal(ended.profile.status, "completed");
            assert.ok(ended.hotFunctions.some((f) => f.name === "polarisBurn"));
            await until(() => existsSync(ready));
            await daemon.stop();
            const directory = await profileDirectory(join(home, "profiles"), workspace, next.id);
            const saved = Schema.decodeUnknownSync(Schema.fromJsonString(ProfileDetail))(
              await readFile(join(directory, "detail.json"), "utf8")
            );
            assert.equal(saved.profile.status, "completed");
            assert.ok(saved.hotFunctions.some((f) => f.name === "polarisBurn"));
            console.log(
              JSON.stringify({
                binary,
                restart: ended.profile.status,
                daemonStop: saved.profile.status,
                originalFrames: ended.nodes.length,
                shutdownFrames: saved.nodes.length,
              })
            );
          });
        })
      ).pipe(Effect.timeout(60000))
    );
  } finally {
    await daemon.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}
