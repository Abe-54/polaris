import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SessionId } from "@polaris/protocol";
import { Effect, Exit, Scope } from "effect";
import type { OpenOptions } from "../HarnessDriver.ts";
import type { SimulatorMcp } from "../simulator/index.ts";
import { text } from "../simulator/session.ts";
import { simulatorTools } from "../simulator/tools.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { FakeClaude } from "./fakeClaude.ts";

const TOKEN_URL = "http://127.0.0.1:9/simulator-mcp/secret-token";

const asked: string[] = [];

const calls: Array<{ name: string; input: unknown }> = [];

const simulator: SimulatorMcp["Service"] = {
  forSession: (sessionId) =>
    Effect.sync(() => {
      asked.push(sessionId);

      return {
        url: TOKEN_URL,
        tools: simulatorTools,
        call: async (name, input) => {
          calls.push({ name, input });

          return text(`called ${name}`);
        },
      };
    }),
};

const optionsOf = async (
  overrides: Partial<OpenOptions>,
  service: SimulatorMcp["Service"] = simulator
) => {
  const fake = new FakeClaude();

  const driver = makeClaudeDriver({
    query: fake.query,
    claudePath: () => "/opt/bin/claude",
    stagingDir: "/tmp/polaris-staging",
    simulator: service,
  });

  const scope = Effect.runSync(Scope.make());

  await Effect.runPromise(
    driver
      .open({
        sessionId: SessionId.make("session-1"),
        cwd: "/work/repo",
        permissionMode: "supervised",
        model: null,
        effort: null,
        resumeCursor: null,
        ...overrides,
      })
      .pipe(Scope.provide(scope))
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  return fake.options!;
};

describe("the Simulator's MCP server in Claude Code", () => {
  test("a session gets the tools in-process, with no token URL in its options", async () => {
    const o = await optionsOf({});
    const server = o.mcpServers?.["polaris_simulator"];

    if (server === undefined || server.type !== "sdk") throw new Error("no SDK server");

    const { instance: _instance, ...entry } = server;

    expect(JSON.stringify({ ...o, mcpServers: { polaris_simulator: entry } })).not.toContain(
      "secret-token"
    );
    expect(JSON.stringify(o.allowedTools ?? [])).not.toContain("polaris_simulator");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "simulator-test", version: "1" });

    try {
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name)).toContain("simulator_open");
      await client.callTool({ name: "simulator_tap", arguments: { target: "@e3" } });

      expect(calls).toEqual([{ name: "simulator_tap", input: { target: "@e3" } }]);
    } finally {
      await client.close();
      await server.instance.close();
    }
  });

  test("a read-only session gets no Simulator and asks for none", async () => {
    asked.length = 0;
    const o = await optionsOf({ readOnly: true });

    expect(o.mcpServers).toEqual({});
    expect(asked).toEqual([]);
  });

  test("a Host without the server opens the session without it", async () => {
    const o = await optionsOf({}, { forSession: () => Effect.succeed(null) });

    expect(o.mcpServers).toBeUndefined();
  });
});
