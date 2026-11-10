/**
 * `polaris_desktop`, the computer use MCP server the Daemon runs for each Agent Session (ENG-846,
 * ADR 0104): agent-desktop's commands as tools. Claude Code gets them in process, Codex over HTTP.
 */
import type { SessionId } from "@polaris/protocol";
import { Duration, Effect, Layer, Predicate, Context, type Scope, Stream } from "effect";
import { jsonSchema } from "../../mcp/tools/shared.ts";
import { EventStore } from "../../store/EventStore.ts";
import type { Authorize } from "./authorize.ts";
import { type DisplayAwake, hostAwake } from "./awake.ts";
import { DESKTOP_TOOLS, type DesktopTool, type Json } from "./catalog.ts";
import type { DesktopResult } from "./envelope.ts";
import type { DesktopHost } from "./host.ts";
import { desktopHttp, type ListedTool } from "./http.ts";
import { type DesktopRunner, directRunner, helperRunner } from "./runner.ts";
import { type Acted, desktopSession } from "./session.ts";
import { type Takeover, takeover } from "./takeover.ts";

export { DESKTOP_MCP_NAME, computerUseCallOf } from "./metadata.ts";

export type { Authorize, DesktopCall, Authorization } from "./authorize.ts";

export { computerUseDesktopHost, type DesktopHost } from "./host.ts";

export type { Acted, ActedOn } from "./session.ts";

export type { DesktopResult, DesktopContent } from "./envelope.ts";

/** The most a session's open waits for the Host's check; then it opens without the tools. */
const READY_TIMEOUT = Duration.seconds(10);

export interface DesktopBoundTool extends ListedTool {
  readonly call: (input: Json, signal?: AbortSignal) => Promise<DesktopResult>;
}

export interface DesktopServer {
  readonly tools: ReadonlyArray<DesktopBoundTool>;
  readonly instructions: string;
  /** Codex's way in: a loopback URL that lasts as long as the scope. */
  readonly url: Effect.Effect<string, never, Scope.Scope>;
}

export interface DesktopSessionOpen {
  readonly sessionId: SessionId;
  /** Read-only sessions and the Reviewer never get computer use. */
  readonly readOnly?: boolean;
}

/** What the server reads about sessions: titles for the overlay, Turn ends to let the display sleep. */
export interface DesktopSessions {
  readonly title: (sessionId: SessionId) => Effect.Effect<string | null>;
  readonly turnEnds: (
    sessionId: SessionId
  ) => Effect.Effect<Stream.Stream<unknown>, never, Scope.Scope>;
}

export interface DesktopMcpDeps {
  readonly runner: DesktopRunner;
  readonly host: DesktopHost;
  readonly sessions: DesktopSessions;
  /** The Host's app policy: approvals, the refused apps and one session per app. */
  readonly authorize: Authorize;
  readonly awake?: DisplayAwake;
  readonly takeover?: Takeover;
  /** D4's preview targets (`PreviewTargets.acted`); none until it is wired in. */
  readonly acted?: Acted | undefined;
}

export const desktopInstructions = (host: string) =>
  `polaris_desktop controls native apps on ${host} through their accessibility trees: snapshot an app, act on its refs, then snapshot again to check. Use it for native apps and for any app the user names; for web pages use polaris_browser. The user approves each app the first time a session uses it, and one session uses an app at a time. Headed tools move the real pointer and keyboard, only for apps with no accessibility tree, and need the user's approval for that app; if the user takes the pointer or keyboard back, stop and wait for them.`;

const listed = (definition: DesktopTool): ListedTool => ({
  name: definition.name,
  description: definition.description,
  inputSchema: jsonSchema(definition.input),
  annotations: { readOnlyHint: definition.observes },
});

const make = (deps: DesktopMcpDeps) => {
  const http = desktopHttp();
  const awake = deps.awake ?? hostAwake();
  const userInput = deps.takeover ?? takeover();

  const open = Effect.fnUntraced(function* (sessionId: SessionId) {
    const session = desktopSession({
      sessionId,
      runner: deps.runner,
      host: deps.host,
      authorize: deps.authorize,
      takeover: userInput,
      awake,
      title: deps.sessions.title(sessionId),
      acted: deps.acted,
    });

    yield* Effect.addFinalizer(() => session.close);
    const ends = yield* deps.sessions.turnEnds(sessionId);
    yield* Effect.forkScoped(Stream.runForEach(ends, () => session.turnEnded));

    const tools = DESKTOP_TOOLS.map((definition): DesktopBoundTool => ({
      ...listed(definition),
      call: (input, signal) => Effect.runPromise(session.call(definition, input, signal)),
    }));

    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    return {
      tools,
      instructions: desktopInstructions(deps.host.name),
      url: http.serve({
        tools: DESKTOP_TOOLS.map(listed),
        instructions: desktopInstructions(deps.host.name),
        call: (name, input, signal) =>
          byName.get(name)?.call(input, signal) ??
          Promise.resolve({ content: [{ type: "text", text: "No such tool" }], isError: true }),
      }),
    } satisfies DesktopServer;
  });

  const ready = deps.host.ready.pipe(
    Effect.timeoutOrElse({ duration: READY_TIMEOUT, orElse: () => Effect.succeed(false) })
  );

  return DesktopMcp.of({
    forSession: (options) =>
      Effect.gen(function* () {
        if (options.readOnly === true || !(yield* ready)) return null;

        return yield* open(options.sessionId);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logWarning(`session ${options.sessionId}: no computer use tools`, cause),
            null
          )
        ),
        Effect.withSpan("DesktopMcp.forSession")
      ),
  });
};

/** Each session's title and Turn ends, from the event store. */
export const storeSessions = Effect.gen(function* () {
  const store = yield* EventStore;

  return {
    title: (sessionId) =>
      Effect.map(store.model, (model) => model.sessions.get(sessionId)?.session.title ?? null),
    turnEnds: (sessionId) =>
      store.subscribe({
        sessionId,
        filter: (item) =>
          Predicate.isTagged(item, "Event") && Predicate.isTagged(item.envelope.event, "TurnEnded"),
      }),
  } satisfies DesktopSessions;
});

export class DesktopMcp extends Context.Service<
  DesktopMcp,
  {
    /**
     * The session's server while the scope lasts, or null: for read-only sessions, when the
     * Host isn't ready, and on any failure, so the session opens without computer use.
     */
    readonly forSession: (
      options: DesktopSessionOpen
    ) => Effect.Effect<DesktopServer | null, never, Scope.Scope>;
  }
>()("polaris/daemon/harness/DesktopMcp") {
  static readonly layerWith = (deps: DesktopMcpDeps) => Layer.sync(DesktopMcp, () => make(deps));

  /** agent-desktop inside the helper on macOS, the Host's own elsewhere; `host` says when it's ready. */
  static readonly layerOn = <R, R2>(
    host: Effect.Effect<DesktopHost, never, R>,
    authorize: Effect.Effect<Authorize, never, R2>,
    acted?: Acted
  ) =>
    Layer.effect(
      DesktopMcp,
      Effect.gen(function* () {
        const runner = process.platform === "darwin" ? yield* helperRunner : yield* directRunner;

        return make({
          runner,
          host: yield* host,
          sessions: yield* storeSessions,
          authorize: yield* authorize,
          acted,
        });
      })
    );

  static readonly none = Layer.succeed(DesktopMcp)(
    DesktopMcp.of({ forSession: () => Effect.succeed(null) })
  );
}
