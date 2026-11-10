/**
 * `polaris_desktop` in a Claude Code session: an in-process SDK MCP server. Its tools are
 * pre-allowed, since Polaris's own approvals (`authorize`, D3) gate each app.
 */
import { createSdkMcpServer, type Options, tool } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Schema } from "effect";
import { z } from "zod";
import type { OpenOptions } from "../HarnessDriver.ts";
import { DESKTOP_MCP_NAME, type DesktopMcp, type DesktopServer } from "../desktop/index.ts";

/** The SDK supplies cancellation in its handler context. */
const HandlerContext = Schema.Struct({
  signal: Schema.optionalKey(Schema.instanceOf(AbortSignal)),
});

const decodeContext = Schema.decodeUnknownSync(HandlerContext);

const decodeInput = Schema.decodeUnknownSync(Schema.Json);

const PREFIX = `mcp__${DESKTOP_MCP_NAME}__`;

/** Plan mode honours only exact names, so the tools that only look are named one by one. */
export const desktopAllowedTools = (server: DesktopServer): ReadonlyArray<string> => [
  `${PREFIX}*`,
  ...server.tools.filter((t) => t.annotations.readOnlyHint).map((t) => `${PREFIX}${t.name}`),
];

export const desktopSdkServer = (server: DesktopServer) =>
  createSdkMcpServer({
    name: DESKTOP_MCP_NAME,
    version: "1",
    instructions: server.instructions,
    tools: server.tools.map((bound) => {
      const schema = z.fromJSONSchema(bound.inputSchema);

      if (!(schema instanceof z.ZodObject))
        throw new Error("A desktop tool's input must be an object");

      return tool(
        bound.name,
        bound.description,
        schema.shape,
        async (input, extra) => {
          const result = await bound.call(decodeInput(input), decodeContext(extra).signal);

          return { content: [...result.content], isError: result.isError };
        },
        { annotations: bound.annotations }
      );
    }),
  });

export const claudeDesktopOptions = Effect.fnUntraced(function* (
  desktop: DesktopMcp["Service"] | undefined,
  options: OpenOptions,
  sdkOptions: Options
) {
  if (desktop === undefined || options.readOnly === true) return {};
  const server = yield* desktop.forSession(options);

  if (server === null) return {};

  return {
    mcpServers: { ...sdkOptions.mcpServers, [DESKTOP_MCP_NAME]: desktopSdkServer(server) },
    allowedTools: [...(sdkOptions.allowedTools ?? []), ...desktopAllowedTools(server)],
  } satisfies Partial<Options>;
});
