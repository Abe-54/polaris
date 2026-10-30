import { afterEach, describe, expect, test } from "bun:test";
import { SessionId } from "@polaris/protocol";
import { Effect } from "effect";
import { agentBrowserServer, type BrowserMcp } from "../browser/index.ts";
import { makeCodexDriver } from "./CodexDriver.ts";
import { cleanup, scripted, sessionWith } from "./testing/session.ts";

const browser: BrowserMcp["Service"] = {
  forSession: (sessionId) =>
    Effect.succeed(agentBrowserServer("/opt/ab", sessionId, `/cfg/${sessionId}.json`)),
};

const withSession = sessionWith((options) => makeCodexDriver({ ...options, browser }));

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

describe("the Browser's MCP server in Codex", () => {
  test("thread start and resume get agent-browser as a stdio server", async () => {
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
          "mcp_servers.polaris_browser": {
            command: "/opt/ab",
            args: ["mcp", "--tools", "core"],
            env: { AGENT_BROWSER_CONFIG: "/cfg/s1.json" },
          },
        },
      });
      expect(JSON.stringify(params)).not.toContain("approval_mode");
    }
  });

  test("a Constellation's server and the Browser's sit side by side", async () => {
    const attachment = {
      sessionId: SessionId.make("s1"),
      instructions: "Polaris worker instructions",
      url: "http://127.0.0.1:12345/mcp/test",
      tools: [],
    };

    const { server } = await withSession(
      scripted(() => {}),
      () => Effect.void,
      { constellation: attachment }
    );

    const config = server.requests("thread/start")[0]?.params;

    expect(config).toMatchObject({
      config: {
        "mcp_servers.polaris": { url: attachment.url },
        "mcp_servers.polaris_browser": { command: "/opt/ab" },
      },
    });
  });

  test("a read-only thread gets no Browser", async () => {
    const { server } = await withSession(
      scripted(() => {}),
      () => Effect.void,
      { readOnly: true }
    );

    expect(JSON.stringify(server.requests("thread/start")[0]?.params)).not.toContain(
      "polaris_browser"
    );
  });
});
