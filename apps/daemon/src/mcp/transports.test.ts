import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Effect } from "effect";
import { mcpHttp } from "./http.ts";
import { McpTokens } from "./tokens.ts";
import { WORKER_TOOL_NAMES, fakeCommands, workerBinding } from "./testing.ts";
import { attachConstellation } from "../harness/constellation/attachment.ts";
import { claudeConstellationOptions } from "../harness/claude/constellation.ts";

const withServer = async (
  body: (origin: string, token: string, tokens: McpTokens["Service"]) => Promise<void>
) => {
  const root = newTempDir("polaris-mcp-http-", { short: true });

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tokens = yield* McpTokens;
          const token = yield* tokens.issue(workerBinding);
          const { origin } = yield* mcpHttp(fakeCommands().commands);
          yield* Effect.promise(() => body(origin, token, tokens));
        })
      ).pipe(Effect.provide(McpTokens.layer(join(root, "tokens.sqlite"))))
    );
  } finally {
    removeTempDir(root);
  }
};

test("Codex's stateless HTTP endpoint works with a real MCP client; revocation cuts access", () =>
  withServer(async (origin, token, tokens) => {
    const client = new Client({ name: "c1-test", version: "1" });

    try {
      // SAFETY: SDK transport has the same runtime contract; its sessionId getter's undefined differs only under exactOptionalPropertyTypes.
      const transport = new StreamableHTTPClientTransport(
        new URL(`${origin}/mcp/${token}`)
      ) as Transport;

      await client.connect(transport);
      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name)).toEqual(WORKER_TOOL_NAMES);

      const result = await client.callTool({
        name: "progress",
        arguments: { note: "Checks passed" },
      });

      expect(result.isError).not.toBe(true);

      const denied = await client.callTool({
        name: "progress",
        arguments: { role: "lead", note: "forged" },
      });

      expect(denied.isError).toBe(true);
      await Effect.runPromise(tokens.revokeAttempt(workerBinding.attemptId));
      expect(
        (
          await fetch(`${origin}/mcp/${token}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status
      ).toBe(401);
    } finally {
      await client.close();
    }
  }));

test("HTTP refuses idle streams, invalid Origin, bad tokens and malformed JSON", () =>
  withServer(async (origin, token) => {
    const url = `${origin}/mcp/${token}`;
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(405);
    expect(
      (await fetch(url, { method: "POST", headers: { origin: "https://evil.example" } })).status
    ).toBe(403);
    expect((await fetch(`${origin}/mcp/${"0".repeat(64)}`)).status).toBe(401);
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(415);

    const malformed = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(await malformed.json()).toMatchObject({ error: { code: -32700 } });

    const notify = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    expect(notify.status).toBe(202);
  }));

test("Claude's in-process server exposes valid schemas and bound handlers; revoke on handover or settle", async () => {
  const root = newTempDir("polaris-mcp-claude-", { short: true });

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const tokens = yield* McpTokens;

        const attachment = yield* attachConstellation(
          workerBinding,
          "http://127.0.0.1:12345",
          fakeCommands().commands
        );

        const server = claudeConstellationOptions([attachment]).mcpServers?.polaris;

        if (server === undefined || server.type !== "sdk") throw new Error("Missing SDK server");
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "c1-test", version: "1" });
        yield* Effect.promise(async () => {
          try {
            await server.instance.connect(serverTransport);
            await client.connect(clientTransport);
            const list = await client.listTools();
            expect(list.tools.find((tool) => tool.name === "claim")?.inputSchema).toHaveProperty(
              "properties.claim"
            );
            expect(
              (await client.callTool({ name: "progress", arguments: { note: "Ready" } })).isError
            ).not.toBe(true);
            await Effect.runPromise(tokens.revokeAttempt(workerBinding.attemptId));
            expect(
              (await client.callTool({ name: "progress", arguments: { note: "Late" } })).isError
            ).toBe(true);
          } finally {
            await client.close();
            await server.instance.close();
          }
        });
      }).pipe(Effect.provide(McpTokens.layer(join(root, "tokens.sqlite"))))
    );
  } finally {
    removeTempDir(root);
  }
});
