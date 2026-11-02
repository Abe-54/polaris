import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";
import { expect } from "bun:test";
import { join } from "node:path";
import type { Claim } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import type { McpBinding } from "./binding.ts";
import type { ConstellationCommands } from "./tools.ts";
import { FriendlyReview } from "./tools/inputs.ts";
import { McpTokens } from "./tokens.ts";
import { mcpHttp } from "./http.ts";

interface ToolInput {
  claim?: Claim;
  task?: string;
  revision?: number;
  action?: typeof FriendlyReview.Type;
  json?: boolean;
}

const ToolResponse = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optionalKey(Schema.Boolean),
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  }),
});

export const callSendbackTool = async (
  binding: McpBinding,
  commands: ConstellationCommands,
  name: string,
  input: ToolInput
) => {
  const tokenRoot = newTempDir("polaris-sendback-mcp-", { short: true });

  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tokens = yield* McpTokens;
          const token = yield* tokens.issue(binding);
          const { origin } = yield* mcpHttp(commands);

          const json = yield* Effect.promise(async () => {
            const response = await fetch(`${origin}/mcp/${token}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name, arguments: input },
              }),
            });

            expect(response.status).toBe(200);

            return response.json();
          });

          const { result } = Schema.decodeUnknownSync(ToolResponse)(json);

          expect(result.isError, JSON.stringify(result.content)).not.toBe(true);

          return result.content.map((c) => c.text).join("\n");
        })
      ).pipe(Effect.provide(McpTokens.layer(join(tokenRoot, "mcp.sqlite"))))
    );
  } finally {
    removeTempDir(tokenRoot);
  }
};
