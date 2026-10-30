/**
 * The Browser's MCP server for an Agent Session (ADR 0092): `agent-browser mcp` over stdio,
 * attached to the session's CDP relay. Claude Code and Codex sessions get it; read-only ones don't.
 */
import type { SessionId } from "@polaris/protocol";
import { join } from "node:path";
import { Cause, Context, type Duration, Effect, Layer, type Scope } from "effect";
import { CdpRelay } from "../../browser/cdpRelay.ts";
import { AgentBrowser } from "../../install/agentBrowser/index.ts";
import { paths } from "../../paths.ts";
import { type ConfigFiles, sessionConfigs } from "./sessionConfig.ts";

/** Not `browser`: a user's own server of that name would shadow or be shadowed by it. */
export const BROWSER_MCP_NAME = "polaris_browser";

/** Shut a session's agent-browser daemon down after 10 idle minutes; attached ones never would. */
const IDLE_TIMEOUT_MS = "600000";

/** The most a session's open waits for its Browser; then it opens without one. */
const SETUP_TIMEOUT: Duration.Input = "10 seconds";

export interface BrowserMcpOptions {
  readonly setupTimeout?: Duration.Input;
  readonly files?: ConfigFiles;
}

/** Nothing here is secret: the relay URL is in the file `AGENT_BROWSER_CONFIG` names. */
export interface BrowserMcpServer {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The `core` tools profile, pinned rather than left to agent-browser's default: navigation,
 * snapshots, clicks and typing, waits, reads, screenshots, eval and tabs (29 tools in 0.41.0).
 */
export const agentBrowserServer = (
  binary: string,
  sessionId: SessionId,
  config: string
): BrowserMcpServer => ({
  command: binary,
  args: ["mcp", "--tools", "core"],
  env: {
    AGENT_BROWSER_CONFIG: config,
    AGENT_BROWSER_SESSION: `polaris-${sessionId}`,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: IDLE_TIMEOUT_MS,
  },
});

/** Hides a relay token that a cause's message may carry. */
export const redactRelayUrls = (text: string): string =>
  text.replaceAll(/(\/browser\/[^/\s]+\/)[^\s"'/]+/g, "$1<redacted>");

export class BrowserMcp extends Context.Service<
  BrowserMcp,
  {
    /**
     * The session's server while the scope lasts, or null when the relay or the binary isn't
     * there: never a failure, so the session opens without Browser tools.
     */
    readonly forSession: (
      sessionId: SessionId
    ) => Effect.Effect<BrowserMcpServer | null, never, Scope.Scope>;
  }
>()("polaris/daemon/harness/BrowserMcp") {
  /** Session configs go in `dir()`, read on the first session. */
  static readonly layerAt = (dir: () => string, options: BrowserMcpOptions = {}) =>
    Layer.effect(
      BrowserMcp,
      Effect.gen(function* () {
        const relay = yield* CdpRelay;
        const agentBrowser = yield* AgentBrowser;
        let configs: ReturnType<typeof sessionConfigs> | null = null;

        return BrowserMcp.of({
          forSession: (sessionId) =>
            Effect.gen(function* () {
              const { binary } = yield* agentBrowser.current;
              const { url } = yield* relay.issue(sessionId);
              configs ??= sessionConfigs(dir(), options.files);
              const config = yield* configs(sessionId, url);

              return agentBrowserServer(binary, sessionId, config);
            }).pipe(
              Effect.timeoutOrElse({
                duration: options.setupTimeout ?? SETUP_TIMEOUT,
                orElse: () =>
                  Effect.fail(new Error("setting up the Browser took too long; skipped")),
              }),
              Effect.catchCause((cause) =>
                Effect.as(
                  Effect.logWarning(
                    `session ${sessionId}: no Browser tools: ${redactRelayUrls(String(Cause.squash(cause)))}`
                  ),
                  null
                )
              ),
              Effect.withSpan("BrowserMcp.forSession")
            ),
        });
      })
    );

  /** Session configs live in `~/.polaris/browser-sessions/`. */
  static readonly layer = BrowserMcp.layerAt(() => join(paths().root, "browser-sessions"));

  static readonly none = Layer.succeed(BrowserMcp)(
    BrowserMcp.of({ forSession: () => Effect.succeed(null) })
  );
}
