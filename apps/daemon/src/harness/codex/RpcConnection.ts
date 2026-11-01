/**
 * A JSON-RPC 2.0 connection to `codex app-server`.
 *
 * app-server's Unix-socket transport is WebSocket over the socket (an HTTP
 * Upgrade, one JSON-RPC message per text frame), which Bun's WebSocket client
 * speaks natively via `ws+unix://<path>`. The `codex --remote unix://<path>`
 * TUI uses the same transport, which is what lets both co-attach.
 */
import { harnessEnv } from "../environment.ts";
import { appendFileSync } from "node:fs";
import { type Cause, Data, Deferred, Effect, Option, Queue, Schema, type Scope } from "effect";
import { HarnessError } from "../HarnessDriver.ts";
import { type Outgoing, type RpcId, RpcMessage, type RpcPayload } from "./protocol.ts";
import { stopChild } from "../../platform/processes.ts";

/** A server notification or server→client request; `params` is undefined when the server sent none. */
export type Incoming = Data.TaggedEnum<{
  Notification: { readonly method: string; readonly params: RpcPayload };
  Request: { readonly id: RpcId; readonly method: string; readonly params: RpcPayload };
}>;

export const Incoming = Data.taggedEnum<Incoming>();

const { Notification, Request } = Incoming;

export interface RpcConnection {
  readonly request: (method: string, params: Outgoing) => Effect.Effect<RpcPayload, HarnessError>;
  readonly notify: (method: string, params?: Outgoing) => Effect.Effect<void, HarnessError>;
  readonly respond: (id: RpcId, result: Outgoing) => Effect.Effect<void, HarnessError>;
  readonly respondError: (
    id: RpcId,
    code: number,
    message: string
  ) => Effect.Effect<void, HarnessError>;
  /** Server notifications and server→client requests, in arrival order; ends on close. */
  readonly incoming: Queue.Dequeue<Incoming, Cause.Done>;
  /** Completes when the connection closes, with a reason unless the client closed it. */
  readonly closed: Deferred.Deferred<string | null>;
}

/** One JSON-RPC message the driver writes. */
interface OutgoingMessage {
  readonly id?: RpcId;
  readonly method?: string;
  readonly params?: Outgoing;
  readonly result?: Outgoing;
  readonly error?: { readonly code: number; readonly message: string };
}

export const codexError = (message: string, cause?: unknown) =>
  new HarnessError(
    cause === undefined ? { harness: "codex", message } : { harness: "codex", message, cause }
  );

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(RpcMessage));

/** `POLARIS_CODEX_TRACE=<file>` appends every JSON-RPC frame as `{dir, msg}` lines (fixtures, debugging). */
const trace = (dir: "in" | "out", raw: string) => {
  const file = process.env.POLARIS_CODEX_TRACE;

  if (!file) return;
  let msg: unknown = raw;

  try {
    msg = JSON.parse(raw);
  } catch {}

  appendFileSync(file, `${JSON.stringify({ dir, msg })}\n`);
};

/** How the core talks to one transport: raw messages out, a close. */
interface Wire {
  readonly send: (raw: string) => void;
  readonly close: () => void;
}

/** What a transport reports back to the core. */
interface WireEvents {
  readonly onMessage: (raw: string) => void;
  /** The transport closed; `reason` is null only when the client closed it. */
  readonly onClose: (reason: string | null) => void;
}

/** JSON-RPC over a transport `open` connects; closing the scope closes it. */
const makeConnection = (
  open: (events: WireEvents) => Effect.Effect<Wire, HarnessError, Scope.Scope>
): Effect.Effect<RpcConnection, HarnessError, Scope.Scope> =>
  Effect.gen(function* () {
    const incoming = yield* Queue.unbounded<Incoming, Cause.Done>();
    const closed = yield* Deferred.make<string | null>();
    const pending = new Map<string, Deferred.Deferred<RpcPayload, HarnessError>>();
    let nextId = 1;
    let closedByClient = false;

    const shutdown = (reason: string | null) => {
      if (!Deferred.doneUnsafe(closed, Effect.succeed(reason))) return;

      for (const deferred of pending.values())
        Deferred.doneUnsafe(
          deferred,
          Effect.fail(codexError(reason ?? "Codex app-server connection closed"))
        );
      pending.clear();
      Queue.endUnsafe(incoming);
    };

    const onMessage = (raw: string) => {
      trace("in", raw);
      const message = decodeMessage(raw);

      if (Option.isNone(message)) return;
      const { id, method, params, result, error } = message.value;

      if (method !== undefined) {
        Queue.offerUnsafe(
          incoming,
          id === undefined ? Notification({ method, params }) : Request({ id, method, params })
        );

        return;
      }

      if (id === undefined) return;
      const deferred = pending.get(String(id));

      if (deferred === undefined) return;
      pending.delete(String(id));
      Deferred.doneUnsafe(
        deferred,
        error === undefined
          ? Effect.succeed(result)
          : Effect.fail(codexError(`${error.message} (code ${error.code})`, error))
      );
    };

    const wire = yield* Effect.acquireRelease(
      open({ onMessage, onClose: (reason) => shutdown(closedByClient ? null : reason) }),
      (opened) =>
        Effect.sync(() => {
          closedByClient = true;
          opened.close();
          shutdown(null);
        })
    );

    const send = (message: OutgoingMessage) =>
      Effect.suspend(() => {
        if (Deferred.isDoneUnsafe(closed))
          return Effect.fail(codexError("Codex app-server connection is closed"));

        return Effect.try({
          try: () => {
            const raw = JSON.stringify(message);
            trace("out", raw);
            wire.send(raw);
          },
          catch: (cause) => codexError("Failed to write to Codex app-server", cause),
        });
      });

    const request = (method: string, params: Outgoing) =>
      Effect.gen(function* () {
        const id = nextId++;
        const deferred = yield* Deferred.make<RpcPayload, HarnessError>();
        pending.set(String(id), deferred);
        yield* send({ id, method, params }).pipe(
          Effect.tapError(() => Effect.sync(() => pending.delete(String(id))))
        );

        return yield* Deferred.await(deferred);
      }).pipe(Effect.mapError((e) => codexError(`${method}: ${e.message}`, e.cause)));

    return {
      request,
      notify: (method, params) => send(params === undefined ? { method } : { method, params }),
      respond: (id, result) => send({ id, result }),
      respondError: (id, code, message) => send({ id, error: { code, message } }),
      incoming,
      closed,
    } satisfies RpcConnection;
  });

/** Opens a JSON-RPC connection over the app-server's Unix socket; closing the scope closes it. */
export const connectUnix = (
  socketPath: string
): Effect.Effect<RpcConnection, HarnessError, Scope.Scope> =>
  connectWebSocket(`ws+unix://${socketPath}`, socketPath);

/** A WebSocket app-server at `url`; `where` names it in errors, `token` is its capability token. */
export const connectWebSocket = (
  url: string,
  where: string,
  token?: string
): Effect.Effect<RpcConnection, HarnessError, Scope.Scope> =>
  makeConnection(({ onMessage, onClose }) =>
    Effect.callback<Wire, HarnessError>((resume) => {
      const ws =
        token === undefined
          ? new WebSocket(url)
          : new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });

      ws.onopen = () =>
        resume(Effect.succeed({ send: (raw) => ws.send(raw), close: () => ws.close() }));
      ws.onerror = (event) => {
        const message = (event instanceof ErrorEvent && event.message) || "WebSocket error";
        resume(Effect.fail(codexError(`Cannot reach Codex app-server at ${where}: ${message}`)));
        onClose(message);
      };

      ws.onclose = (event) => onClose(`Codex app-server closed the connection (${event.code})`);
      ws.onmessage = (event) => onMessage(String(event.data));

      return Effect.sync(() => ws.close());
    })
  );

/**
 * Starts a private `codex app-server` on stdio (one JSON-RPC message per line)
 * and connects to it; closing the scope ends the process. For one-off requests
 * that shouldn't start the shared, detached server.
 */
export const connectStdio = (
  codexPath: string
): Effect.Effect<RpcConnection, HarnessError, Scope.Scope> =>
  makeConnection(({ onMessage, onClose }) =>
    Effect.try({
      try: (): Wire => {
        const proc = Bun.spawn([codexPath, "app-server"], {
          env: harnessEnv(),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });

        void (async () => {
          const decoder = new TextDecoder();
          let buffer = "";

          for await (const chunk of proc.stdout) {
            buffer += decoder.decode(chunk, { stream: true });
            let end = buffer.indexOf("\n");

            while (end >= 0) {
              const line = buffer.slice(0, end).trim();
              buffer = buffer.slice(end + 1);

              if (line !== "") onMessage(line);
              end = buffer.indexOf("\n");
            }
          }

          onClose(`codex app-server exited (${await proc.exited})`);
        })();

        return {
          send: (raw) => {
            void proc.stdin.write(`${raw}\n`);
            void proc.stdin.flush();
          },
          close: () => {
            void proc.stdin.end();
            stopChild(proc);
          },
        };
      },
      catch: (cause) => codexError("Failed to start codex app-server", cause),
    })
  );
