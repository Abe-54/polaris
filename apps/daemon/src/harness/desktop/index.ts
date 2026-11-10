/**
 * `polaris_desktop`, the computer use MCP server the Daemon runs for each Agent Session (ENG-846,
 * ADR 0104): agent-desktop's commands as tools. Claude Code gets them in process, Codex over HTTP.
 */
import type { ComputerUseState, SessionId } from "@polaris/protocol";
import {
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Context,
  type Scope,
  Stream,
} from "effect";
import { jsonSchema } from "../../mcp/tools/shared.ts";
import { EventStore } from "../../store/EventStore.ts";
import { type Authorize, defaultAuthorize } from "./authorize.ts";
import { type DisplayAwake, hostAwake } from "./awake.ts";
import { DESKTOP_TOOLS, type DesktopTool, type Json } from "./catalog.ts";
import type { DesktopResult } from "./envelope.ts";
import { computerUseDesktopHost, type DesktopHost, localDesktopHost } from "./host.ts";
import { desktopHttp, type ListedTool } from "./http.ts";
import {
  callRequest,
  REQUEST_TIMEOUT_MS,
  REQUEST_TOOL,
  requestDescription,
  requestInputSchema,
  requestInstructions,
  type RequestComputerUse,
} from "./request.ts";
import { type DesktopRunner, directRunner, helperRunner } from "./runner.ts";
import { type Acted, desktopSession } from "./session.ts";

export { DESKTOP_MCP_NAME, computerUseCallOf } from "./metadata.ts";

export type { Authorize, DesktopCall, Authorization } from "./authorize.ts";

export type { DesktopHost } from "./host.ts";

export type { Acted, ActedOn } from "./session.ts";

export type { DesktopResult, DesktopContent } from "./envelope.ts";

export {
  ComputerUseOutcome,
  type ComputerUseAsk,
  REQUEST_TOOL,
  type RequestComputerUse,
} from "./request.ts";

/** The most a session's open waits for the Host's check; then it opens without the tools. */
const READY_TIMEOUT = Duration.seconds(10);

/** Longer than the slowest agent-desktop command the runner waits for (90 s). */
const TOOL_CALL_SECONDS = 120;

/** Codex's per-call limit for the request tool: longer than the request waits. */
const REQUEST_CALL_SECONDS = REQUEST_TIMEOUT_MS / 1000 + 60;

export interface DesktopBoundTool extends ListedTool {
  readonly call: (input: Json, signal?: AbortSignal) => Promise<DesktopResult>;
}

export interface DesktopServer {
  readonly tools: ReadonlyArray<DesktopBoundTool>;
  readonly instructions: string;
  /** The longest one call may take, for Harnesses that time tool calls out. */
  readonly callSeconds: number;
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
  /** D3's approvals; until then headed input waits on `POLARIS_COMPUTER_USE_HEADED`. */
  readonly authorize?: Authorize;
  readonly awake?: DisplayAwake;
  /** D4's preview targets (`PreviewTargets.acted`); none until it is wired in. */
  readonly acted?: Acted | undefined;
}

export const desktopInstructions = (host: string) =>
  `polaris_desktop controls native apps on ${host} through their accessibility trees: snapshot an app, act on its refs, then snapshot again to check. Use it for native apps and for any app the user names; for web pages use polaris_browser. Headed tools move the real pointer and keyboard, only for apps with no accessibility tree, and need the user's approval.`;

const listed = (definition: DesktopTool): ListedTool => ({
  name: definition.name,
  description: definition.description,
  inputSchema: jsonSchema(definition.input),
  annotations: { readOnlyHint: definition.observes },
});

const make = (deps: DesktopMcpDeps) => {
  const http = desktopHttp();
  const authorize = deps.authorize ?? defaultAuthorize();
  const awake = deps.awake ?? hostAwake();
  let request: RequestComputerUse | null = null;

  const serve = (
    tools: ReadonlyArray<DesktopBoundTool>,
    instructions: string,
    callSeconds: number
  ): DesktopServer => {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    return {
      tools,
      instructions,
      callSeconds,
      url: http.serve({
        tools: tools.map(({ call: _call, ...listing }) => listing),
        instructions,
        call: (name, input, signal) =>
          byName.get(name)?.call(input, signal) ??
          Promise.resolve({ content: [{ type: "text", text: "No such tool" }], isError: true }),
      }),
    };
  };

  /** Off or NeedsSetup: only `request_computer_use`, which asks the user and waits. */
  const asking = (sessionId: SessionId, state: ComputerUseState): DesktopServer => {
    const tool: DesktopBoundTool = {
      name: REQUEST_TOOL,
      description: requestDescription(state, deps.host.name),
      inputSchema: requestInputSchema,
      annotations: { readOnlyHint: true },
      call: (input, signal) =>
        Effect.runPromise(
          callRequest(sessionId, input, request, () => ({
            state,
            timeoutMs: REQUEST_TIMEOUT_MS,
            ready: deps.host.untilReady,
          })),
          { signal }
        ),
    };

    return serve([tool], requestInstructions(state, deps.host.name), REQUEST_CALL_SECONDS);
  };

  const open = Effect.fnUntraced(function* (sessionId: SessionId) {
    const session = desktopSession({
      sessionId,
      runner: deps.runner,
      host: deps.host,
      authorize,
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

    return serve(tools, desktopInstructions(deps.host.name), TOOL_CALL_SECONDS);
  });

  const state = deps.host.state.pipe(Effect.timeoutOption(READY_TIMEOUT));

  return DesktopMcp.of({
    bindRequests: (requests) => Effect.sync(() => void (request = requests)),
    forSession: (options) =>
      Effect.gen(function* () {
        if (options.readOnly === true) return null;
        const found = Option.getOrNull(yield* state);

        if (found === null) return null;

        return yield* Match.value(found).pipe(
          Match.tag("Ready", () => open(options.sessionId)),
          Match.tag("Off", "NeedsSetup", (off) => Effect.succeed(asking(options.sessionId, off))),
          Match.orElse(() => Effect.succeed(null))
        );
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
const storeSessions = Effect.gen(function* () {
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
     * The session's server while the scope lasts: every tool when the Host is Ready, only
     * `request_computer_use` when it's Off or NeedsSetup. Null for read-only sessions, a Host
     * with no desktop, and on any failure, so the session opens without computer use.
     */
    readonly forSession: (
      options: DesktopSessionOpen
    ) => Effect.Effect<DesktopServer | null, never, Scope.Scope>;
    /** The Engine's `ComputerUseRequests.request`, bound once the Engine is built. */
    readonly bindRequests: (request: RequestComputerUse) => Effect.Effect<void>;
  }
>()("polaris/daemon/harness/DesktopMcp") {
  static readonly layerWith = (deps: DesktopMcpDeps) => Layer.sync(DesktopMcp, () => make(deps));

  /** agent-desktop inside the helper on macOS, the Host's own elsewhere; `host` says when it's ready. */
  static readonly layerOn = <R>(host: Effect.Effect<DesktopHost, never, R>, acted?: Acted) =>
    Layer.effect(
      DesktopMcp,
      Effect.gen(function* () {
        const runner = process.platform === "darwin" ? yield* helperRunner : yield* directRunner;

        return make({ runner, host: yield* host, sessions: yield* storeSessions, acted });
      })
    );

  /** On D1's ComputerUseHost: its state decides the tools, and its display env reaches them. */
  static readonly layer = DesktopMcp.layerOn(computerUseDesktopHost);

  /** Without D1's ComputerUseHost: ready when the helper's grants are, never asking. */
  static readonly layerLocal = DesktopMcp.layerOn(localDesktopHost);

  static readonly none = Layer.succeed(DesktopMcp)(
    DesktopMcp.of({ forSession: () => Effect.succeed(null), bindRequests: () => Effect.void })
  );
}
