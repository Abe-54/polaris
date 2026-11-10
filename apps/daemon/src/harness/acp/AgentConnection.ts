/**
 * One ACP agent process and its JSON-RPC connection (newline-delimited JSON on
 * stdio). A process serves every Agent Session of its Harness on this Host:
 * `session/update` notifications and `session/request_permission` requests are
 * routed to the session they name; anything else the agent asks is refused.
 */
import { harnessEnv } from "../environment.ts";
import { appendFileSync } from "node:fs";
import { Deferred, Effect, Option, Predicate, Schema, type Scope } from "effect";
import { HarnessError } from "../HarnessDriver.ts";
import * as P from "./protocol.ts";
import { stopChild } from "../../platform/processes.ts";
import { readLines } from "../../lines.ts";

/** What a session receives from the agent. */
export interface SessionRoute {
  readonly onUpdate: (update: P.RpcPayload) => void;
  readonly onRequest: (id: P.RpcId, method: string, params: P.RpcPayload) => void;
}

export interface AgentConnection {
  readonly initialize: P.InitializeResponse;
  readonly request: <M extends P.RequestMethod>(
    method: M,
    params: P.ClientParams[M]
  ) => Effect.Effect<P.RpcPayload, HarnessError>;
  /** Like `request`, but keeps the agent's own error (its code tells auth failures apart). */
  readonly call: <M extends P.RequestMethod>(
    method: M,
    params: P.ClientParams[M]
  ) => Effect.Effect<P.RpcPayload, HarnessError | AgentRpcError>;
  readonly notify: (
    method: "session/cancel",
    params: P.ClientParams["session/cancel"]
  ) => Effect.Effect<void, HarnessError>;
  readonly respond: (
    id: P.RpcId,
    result: P.PermissionResponse
  ) => Effect.Effect<void, HarnessError>;
  readonly respondError: (
    id: P.RpcId,
    code: number,
    message: string
  ) => Effect.Effect<void, HarnessError>;
  /** Routes a session's traffic here until the scope closes. */
  readonly route: (
    sessionId: string,
    route: SessionRoute
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Completes when the process exits, with why (null when Polaris stopped it). */
  readonly closed: Deferred.Deferred<string | null>;
}

export interface SpawnOptions {
  readonly harness: string;
  readonly argv: ReadonlyArray<string>;
  readonly clientVersion: string;
}

/** A JSON-RPC error the agent answered with; `code` tells auth and missing methods apart. */
export class AgentRpcError extends Schema.TaggedError<AgentRpcError>()("AgentRpcError", {
  method: Schema.String,
  code: Schema.Number,
  message: Schema.String,
}) {}

/** One JSON-RPC message the driver writes. */
interface OutgoingMessage {
  readonly id?: P.RpcId;
  readonly method?: string;
  readonly params?: P.ClientParams[keyof P.ClientParams];
  readonly result?: P.PermissionResponse;
  readonly error?: { readonly code: number; readonly message: string };
}

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(P.RpcMessage));

const decodeNotification = Schema.decodeUnknownOption(P.SessionNotification);

const decodeSessionScoped = Schema.decodeUnknownOption(Schema.Struct({ sessionId: Schema.String }));

const isAgentRpcError = Predicate.isTagged("AgentRpcError");

/** `POLARIS_ACP_TRACE=<file>` appends every frame as `{dir, msg}` lines (fixtures, debugging). */
const trace = (dir: "in" | "out", raw: string) => {
  const file = process.env.POLARIS_ACP_TRACE;

  if (!file) return;
  appendFileSync(file, `${JSON.stringify({ dir, msg: raw })}\n`);
};

/** Calls `onLine` with each non-blank line of a byte stream, trimmed. */
const trimmedLines = async (
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void
): Promise<void> => {
  for await (const raw of readLines(stream)) {
    const line = raw.trim();

    if (line !== "") onLine(line);
  }
};

/** The last lines the agent wrote to stderr, for the error when it exits. */
const stderrTail = (stream: ReadableStream<Uint8Array>) => {
  const lines: Array<string> = [];

  void trimmedLines(stream, (line) => {
    lines.push(line);

    if (lines.length > 5) lines.shift();
  });

  return () => lines.join("\n");
};

/**
 * Spawns the agent, sends `initialize`, and returns the connection. Closing the
 * scope ends the process. Polaris never offers the agent file system or terminal
 * access (`fs`, `terminal` are false): the Harness uses its own tools.
 */
export const spawnAgent = (
  options: SpawnOptions
): Effect.Effect<AgentConnection, HarnessError, Scope.Scope> =>
  Effect.gen(function* () {
    const fail = (message: string, cause?: unknown) =>
      new HarnessError(
        cause === undefined
          ? { harness: options.harness, message }
          : { harness: options.harness, message, cause }
      );

    const closed = yield* Deferred.make<string | null>();

    const pending = new Map<
      string,
      Deferred.Deferred<P.RpcPayload, HarnessError | AgentRpcError>
    >();

    const routes = new Map<string, SessionRoute>();
    let nextId = 1;
    let stopping = false;

    const proc = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.spawn([...options.argv], {
            env: harnessEnv(),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          }),
        catch: (cause) => fail(`Failed to start ${options.argv[0]}`, cause),
      }),
      (child) =>
        Effect.sync(() => {
          stopping = true;
          void child.stdin.end();
          stopChild(child);
        })
    );

    const tail = stderrTail(proc.stderr);

    const writeRaw = (message: OutgoingMessage) =>
      Effect.suspend(() => {
        if (Deferred.isDoneUnsafe(closed))
          return Effect.fail(fail(`${options.harness} is no longer running`));

        return Effect.try({
          try: () => {
            const raw = JSON.stringify({ jsonrpc: "2.0", ...message });
            trace("out", raw);
            void proc.stdin.write(`${raw}\n`);
            void proc.stdin.flush();
          },
          catch: (cause) => fail(`Failed to write to ${options.harness}`, cause),
        });
      });

    const onRequest = (id: P.RpcId, method: string, params: P.RpcPayload) => {
      const scoped = decodeSessionScoped(params);
      const route = Option.isSome(scoped) ? routes.get(scoped.value.sessionId) : undefined;

      if (route !== undefined) return route.onRequest(id, method, params);
      Effect.runFork(
        writeRaw({
          id,
          error: { code: P.ErrorCode.methodNotFound, message: `Polaris does not handle ${method}` },
        })
      );
    };

    const onLine = (raw: string) => {
      trace("in", raw);
      const message = decodeMessage(raw);

      if (Option.isNone(message)) return;
      const { id, method, params, result, error } = message.value;

      if (method === "session/update") {
        const notification = decodeNotification(params);

        if (Option.isSome(notification))
          routes.get(notification.value.sessionId)?.onUpdate(notification.value.update);

        return;
      }

      if (method !== undefined) {
        if (id !== undefined && id !== null) onRequest(id, method, params);

        return;
      }

      if (id === undefined || id === null) return;
      const deferred = pending.get(String(id));

      if (deferred === undefined) return;
      pending.delete(String(id));
      Deferred.doneUnsafe(
        deferred,
        error === undefined
          ? Effect.succeed(result)
          : Effect.fail(new AgentRpcError({ method: "", code: error.code, message: error.message }))
      );
    };

    void (async () => {
      await trimmedLines(proc.stdout, onLine);
      const code = await proc.exited;

      const reason = stopping
        ? null
        : [`${options.harness} exited (${code})`, tail()].filter(Boolean).join(": ");

      for (const deferred of pending.values())
        Deferred.doneUnsafe(deferred, Effect.fail(fail(reason ?? `${options.harness} stopped`)));
      pending.clear();
      Deferred.doneUnsafe(closed, Effect.succeed(reason));
    })();

    const rawRequest = <M extends P.RequestMethod>(method: M, params: P.ClientParams[M]) =>
      Effect.gen(function* () {
        const id = nextId++;
        const deferred = yield* Deferred.make<P.RpcPayload, HarnessError | AgentRpcError>();
        pending.set(String(id), deferred);
        yield* writeRaw({ id, method, params }).pipe(
          Effect.tapError(() => Effect.sync(() => pending.delete(String(id))))
        );

        return yield* Deferred.await(deferred);
      }).pipe(
        Effect.mapError((e) =>
          isAgentRpcError(e) ? new AgentRpcError({ method, code: e.code, message: e.message }) : e
        )
      );

    const initialized = yield* rawRequest("initialize", {
      protocolVersion: P.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "polaris", title: "Polaris", version: options.clientVersion },
    } satisfies P.ClientParams["initialize"]).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((e) => fail(`${options.harness} did not initialize: ${e.message}`, e)),
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(P.InitializeResponse)(result).pipe(
          Effect.mapError((e) => fail(`Unexpected initialize response from ${options.harness}`, e))
        )
      )
    );

    if (initialized.protocolVersion !== P.PROTOCOL_VERSION)
      return yield* fail(
        `${options.harness} speaks ACP v${initialized.protocolVersion}; Polaris speaks v${P.PROTOCOL_VERSION}`
      );

    return {
      initialize: initialized,
      request: (method, params) =>
        rawRequest(method, params).pipe(
          Effect.catchTag("AgentRpcError", (e) =>
            Effect.fail(fail(`${method}: ${e.message} (code ${e.code})`, e))
          )
        ),
      call: rawRequest,
      notify: (method, params) => writeRaw({ method, params }),
      respond: (id, result) => writeRaw({ id, result }),
      respondError: (id, code, message) => writeRaw({ id, error: { code, message } }),
      route: (sessionId, route) =>
        Effect.acquireRelease(
          Effect.sync(() => void routes.set(sessionId, route)),
          () => Effect.sync(() => void routes.delete(sessionId))
        ),
      closed,
    } satisfies AgentConnection;
  });
