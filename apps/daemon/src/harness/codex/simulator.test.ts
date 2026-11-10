import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { SimulatorMcp } from "../simulator/index.ts";
import { failure } from "../simulator/session.ts";
import { simulatorTools } from "../simulator/tools.ts";
import { makeCodexDriver } from "./CodexDriver.ts";
import { cleanup, scripted, sessionWith } from "./testing/session.ts";

const simulator: SimulatorMcp["Service"] = {
  forSession: (sessionId) =>
    Effect.succeed({
      url: `http://127.0.0.1:9/simulator-mcp/${sessionId}`,
      tools: simulatorTools,
      call: () => Promise.resolve(failure("unused")),
    }),
};

const withSession = sessionWith((options) => makeCodexDriver({ ...options, simulator }));

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

describe("the Simulator's MCP server in Codex", () => {
  test("thread start and resume get the session's URL", async () => {
    for (const resumeCursor of [undefined, "existing-thread"]) {
      const { server } = await withSession(
        scripted(() => {}),
        () => Effect.void,
        resumeCursor === undefined ? {} : { resumeCursor }
      );

      const params = server.requests(
        resumeCursor === undefined ? "thread/start" : "thread/resume"
      )[0]?.params;

      expect(params).toMatchObject({
        config: {
          "mcp_servers.polaris_simulator": {
            url: "http://127.0.0.1:9/simulator-mcp/s1",
            tool_timeout_sec: 120,
          },
        },
      });
      expect(JSON.stringify(params)).not.toContain("approval_mode");
    }
  });

  test("a read-only thread gets no Simulator", async () => {
    const { server } = await withSession(
      scripted(() => {}),
      () => Effect.void,
      { readOnly: true }
    );

    expect(JSON.stringify(server.requests("thread/start")[0]?.params)).not.toContain(
      "polaris_simulator"
    );
  });
});
