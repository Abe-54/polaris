import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ConstellationFinding,
  ConstellationGraphSlice,
  ConstellationRejected,
} from "@polaris/protocol";
import { FriendlyReview } from "./inputs.ts";
import { ReviewAction } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { LEAD_TOOL_NAMES, fakeCommands, leadBinding } from "../testing.ts";
import { McpTokens } from "../tokens.ts";
import { mcpHttp } from "../http.ts";
import { attachConstellation } from "../../harness/constellation/attachment.ts";
import { claudeConstellationOptions } from "../../harness/claude/constellation.ts";

for (const transport of ["http", "claude"] as const) {
  test(`friendly Lead schemas and structured findings work through ${transport} MCP`, async () => {
    const root = newTempDir("polaris-c1-t-mcp-", { short: true });
    const fake = fakeCommands();
    let deny = false;

    const refusal = new ConstellationRejected({
      findings: [
        new ConstellationFinding({
          code: "E-REVISION",
          message: "Attempt changed",
          fix: "Read status and review the current Claim.",
        }),
      ],
      graph: new ConstellationGraphSlice({
        constellationId: leadBinding.constellationId,
        revision: 12,
        tasks: [],
        attempts: [],
      }),
      revision: 12,
    });

    const commands = {
      ...fake.commands,
      command: (...args: Parameters<typeof fake.commands.command>) =>
        deny ? Effect.fail(refusal) : fake.commands.command(...args),
    };

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { origin } = yield* mcpHttp(commands);
            const attachment = yield* attachConstellation(leadBinding, origin, commands);
            const client = new Client({ name: "c1-t-test", version: "1" });
            const server = claudeConstellationOptions([attachment]).mcpServers?.polaris;

            if (server === undefined || server.type !== "sdk")
              throw new Error("Missing SDK server");
            yield* Effect.promise(async () => {
              try {
                if (transport === "http") {
                  // SAFETY: the SDK transport contract differs only by sessionId's undefined under exactOptionalPropertyTypes.
                  const connection = new StreamableHTTPClientTransport(
                    new URL(attachment.url)
                  ) as Transport;

                  await client.connect(connection);
                } else {
                  const [local, remote] = InMemoryTransport.createLinkedPair();
                  await server.instance.connect(remote);
                  await client.connect(local);
                }

                const tools = await client.listTools();
                expect(tools.tools.map((tool) => tool.name)).toEqual(LEAD_TOOL_NAMES);

                const result = await client.callTool({
                  name: "review",
                  arguments: {
                    task: "A1",
                    revision: 1,
                    action: Schema.encodeSync(FriendlyReview)(
                      FriendlyReview.cases.SendBack.make({
                        reason: "Rebase onto the merge result",
                        mergeConflictBase: "base",
                        worker: { host: "local", selection: { model: "Sol" } },
                      })
                    ),
                  },
                });

                expect(result.isError).not.toBe(true);
                expect(fake.calls[0]?.command).toMatchObject({
                  action: {
                    worker: { hostId: "host-local", selection: { model: "model-Sol" } },
                    mergeConflictBase: "base",
                  },
                });
                deny = true;

                const error = await client.callTool({
                  name: "review",
                  arguments: {
                    task: "A1",
                    revision: 1,
                    action: ReviewAction.cases.Stop.make({ reason: "Stop current Attempt" }),
                  },
                });

                expect(error.isError).toBe(true);
                expect(error.structuredContent).toMatchObject({
                  findings: refusal.findings.map(({ code, message, fix }) => ({
                    code,
                    message,
                    fix,
                  })),
                  revision: 12,
                  graph: { constellationId: leadBinding.constellationId },
                });
                expect(error.content).toEqual([
                  {
                    type: "text",
                    text: "E-REVISION: Attempt changed\nFix: Read status and review the current Claim.\nRevision: 12\nNext: Apply these fixes and retry; read status if the graph changed.",
                  },
                ]);
              } finally {
                await client.close();
                await server.instance.close();
              }
            });
          })
        ).pipe(Effect.provide(McpTokens.layer(join(root, "tokens.sqlite"))))
      );
    } finally {
      removeTempDir(root);
    }
  });
}
