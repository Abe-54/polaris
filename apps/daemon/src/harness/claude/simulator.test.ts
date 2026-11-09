import { describe, expect, test } from "bun:test";
import { SessionId } from "@polaris/protocol";
import { Effect, Exit, Scope } from "effect";
import type { OpenOptions } from "../HarnessDriver.ts";
import type { SimulatorMcp } from "../simulator/index.ts";
import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { FakeClaude } from "./fakeClaude.ts";

const asked: string[] = [];

const simulator: SimulatorMcp["Service"] = {
  forSession: (sessionId) =>
    Effect.sync(() => {
      asked.push(sessionId);

      return { url: `http://127.0.0.1:9/simulator-mcp/${sessionId}` };
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
  test("a session gets its own URL as an HTTP server, not pre-allowed", async () => {
    const o = await optionsOf({});

    expect(o.mcpServers?.["polaris_simulator"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:9/simulator-mcp/session-1",
    });
    expect(JSON.stringify(o.allowedTools ?? [])).not.toContain("polaris_simulator");
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
