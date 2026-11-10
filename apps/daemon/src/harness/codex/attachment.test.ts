import { afterEach, describe, expect, test } from "bun:test";
import { SECRET_REQUEST_MAX_TIMEOUT_MS, SessionId } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { polarisInstructions } from "../../constellation/skills/preamble.ts";
import { constellationTools } from "../../mcp/tools.ts";
import { fakeCommands, workerBinding } from "../../mcp/testing.ts";
import { makeCodexDriver } from "./CodexDriver.ts";
import { cleanup, scripted, sessionWith } from "./testing/session.ts";

const withSession = sessionWith(makeCodexDriver);

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const PolarisServerConfig = Schema.decodeUnknownSync(
  Schema.Struct({
    config: Schema.Struct({
      "mcp_servers.polaris": Schema.Struct({ tool_timeout_sec: Schema.Number }),
    }),
  })
);

describe("Constellation attachment", () => {
  const attachment = {
    sessionId: SessionId.make("s1"),
    instructions: "Polaris worker instructions",
    url: "http://127.0.0.1:12345/mcp/test",
    tools: [],
  };

  test("thread start and resume receive per-thread MCP config and developer instructions", async () => {
    for (const resumeCursor of [undefined, "existing-thread"]) {
      const options =
        resumeCursor === undefined
          ? { constellation: attachment }
          : { constellation: attachment, resumeCursor };

      const { server } = await withSession(
        scripted(() => {}),
        () => Effect.void,
        options
      );

      const method = resumeCursor === undefined ? "thread/start" : "thread/resume";
      expect(server.requests(method)[0]?.params).toMatchObject({
        developerInstructions: polarisInstructions({ constellation: attachment }),
        config: { "mcp_servers.polaris": { url: attachment.url } },
      });
      // A Secret Request waits up to an hour; Codex would cut the call at its 60 s default.
      const { config } = PolarisServerConfig(server.requests(method)[0]?.params);
      expect(config["mcp_servers.polaris"]?.tool_timeout_sec).toBeGreaterThan(
        SECRET_REQUEST_MAX_TIMEOUT_MS / 1000
      );
    }
  });
  test("visualize runs unasked: its server sets the tool's approval_mode", async () => {
    const tools = constellationTools(workerBinding, fakeCommands().commands);

    const { server } = await withSession(
      scripted(() => {}),
      () => Effect.void,
      { constellation: { ...attachment, tools } }
    );

    expect(server.requests("thread/start")[0]?.params).toMatchObject({
      config: {
        "mcp_servers.polaris": { tools: { visualize: { approval_mode: "approve" } } },
      },
    });
  });
  test("unattached thread start and resume receive common context without MCP servers", async () => {
    for (const resumeCursor of [undefined, "existing-thread"]) {
      const { server } = await withSession(
        scripted(() => {}),
        () => Effect.void,
        resumeCursor === undefined ? {} : { resumeCursor }
      );

      const method = resumeCursor === undefined ? "thread/start" : "thread/resume";
      const params = server.requests(method)[0]?.params;
      expect(params).toHaveProperty("developerInstructions", polarisInstructions({}));
      // Codex's own computer use is off on every thread; no MCP server is configured.
      expect(params).toHaveProperty("config", { "features.computer_use": false });
    }
  });
  test("Gate start and resume retain both role servers and trusted worker environment", async () => {
    const worker = {
      ...attachment,
      instructions: "Gate Worker instructions",
      url: `${attachment.url}-worker`,
    };

    const environment = {
      POLARIS_HOST_SOCKET: "/tmp/polaris-test.sock",
      POLARIS_SESSION_ID: attachment.sessionId,
    };

    for (const resumeCursor of [null, "existing-gate"]) {
      const base = { constellations: [attachment, worker], environment };
      const options = resumeCursor === null ? base : { ...base, resumeCursor };

      const { server } = await withSession(
        scripted(() => {}),
        () => Effect.void,
        options
      );

      expect(
        server.requests(resumeCursor === null ? "thread/start" : "thread/resume")[0]?.params
      ).toMatchObject({
        developerInstructions: polarisInstructions({ constellations: [attachment, worker] }),
        config: {
          "mcp_servers.polaris": { url: attachment.url },
          "mcp_servers.polaris_1": { url: worker.url },
          "shell_environment_policy.set": environment,
        },
      });
    }
  });
  test("the Reviewer receives no Constellation tools even with an attachment", async () => {
    const { server } = await withSession(
      scripted(() => {}),
      () => Effect.void,
      { constellation: attachment, readOnly: true }
    );

    const params = server.requests("thread/start")[0]?.params;
    expect(params).toHaveProperty("developerInstructions", polarisInstructions({ readOnly: true }));
    // The only MCP server named is the user's own, turned off.
    expect(params).toMatchObject({ config: { mcp_servers: { linear: { enabled: false } } } });
    expect(JSON.stringify(params)).not.toContain("mcp_servers.polaris");
    expect(JSON.stringify(params)).not.toContain('"polaris":');
  });
  test("an attachment from another session is refused before thread start", async () => {
    await Promise.resolve(
      expect(
        withSession(
          scripted(() => {}),
          () => Effect.void,
          { constellation: { ...attachment, sessionId: SessionId.make("other") } }
        )
      ).rejects.toThrow("another session")
    );
  });
});
