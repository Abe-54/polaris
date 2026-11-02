import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import { mcpHttp } from "../../mcp/http.ts";
import { fakeCommands } from "../../mcp/testing.ts";
import { McpTokens } from "../../mcp/tokens.ts";
import { probeEndpoint } from "./provider.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

test("the MCP probe answers true for a live listener and false for a dead one", async () => {
  const root = newTempDir("polaris-probe-");

  try {
    const live = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* mcpHttp(fakeCommands().commands);

          return yield* probeEndpoint(origin);
        })
      ).pipe(Effect.provide(McpTokens.layer(join(root, "tokens.sqlite"))))
    );

    expect(live).toBe(true);
    // Port 9 is the discard service; nothing listens there on a developer machine.
    expect(await Effect.runPromise(probeEndpoint("http://127.0.0.1:9"))).toBe(false);
  } finally {
    removeTempDir(root);
  }
});
