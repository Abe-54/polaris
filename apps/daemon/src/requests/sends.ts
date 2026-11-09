/** The send engine: prepare, gate an agent's Send, transmit, record the root Span and the Send Log. */
import { isWriteMethod, type Send, type SendLookup } from "@polaris/protocol";
import { Effect, Layer, Match, PubSub, Stream } from "effect";
import { TraceSessions } from "../traces/sessionsService.ts";
import { TraceStore } from "../traces/storeService.ts";
import { prepare, type PreparedRequest } from "./prepare.ts";
import { masker, sendRecord, type Masker } from "./record.ts";
import { rootSpanRequest, sendTraceContext, type SendTraceContext } from "./rootSpan.ts";
import { notFound, SendLogFile, storageError, type PageOptions } from "./sendLog.ts";
import {
  RequestSends,
  type PendingSend,
  type PreSendHook,
  type PreSendVerdict,
  type RequestSendsOptions,
  type SendInput,
} from "./sendsService.ts";
import { transmit, type Transmission } from "./transmit.ts";

const nowNano = () => BigInt(Date.now()) * 1_000_000n;

const parts = (url: string) => {
  try {
    const parsed = new URL(url);

    return { origin: parsed.origin, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { origin: "", path: "" };
  }
};

const pending = (
  input: SendInput,
  prepared: PreparedRequest,
  mask: Masker,
  by: PendingSend["by"]
): PendingSend => {
  const { origin, path } = parts(prepared.request.url);

  return {
    checkout: input.checkout,
    ref: prepared.ref,
    ...(prepared.environment === undefined ? undefined : { environment: prepared.environment }),
    method: prepared.request.method,
    write: isWriteMethod(prepared.request.method),
    origin,
    url: mask.url(prepared.request.url),
    path: mask.text(path),
    variables: prepared.variables,
    by,
  };
};

const runHooks = (hooks: ReadonlySet<PreSendHook>, send: PendingSend) =>
  Effect.gen(function* () {
    for (const hook of hooks) {
      const verdict: PreSendVerdict = yield* hook(send);

      if (!verdict.allow) return verdict;
    }

    return { allow: true } as const;
  });

const errorOf = (transmission: Transmission) =>
  "error" in transmission ? transmission.error : undefined;

export const requestSendsLayerAt = (filename: string, options: RequestSendsOptions = {}) =>
  Layer.effect(
    RequestSends,
    Effect.gen(function* () {
      const store = yield* TraceStore;
      const sessions = yield* TraceSessions;
      const hooks = new Set<PreSendHook>();
      const changes = yield* PubSub.sliding<string>(64);
      let file: SendLogFile | undefined;

      yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
      yield* Effect.addFinalizer(() => Effect.sync(() => file?.close()));

      // Opened on first use, so a Daemon that never sends never touches the file.
      const log = Effect.try({
        try: () => (file ??= SendLogFile.open(filename)),
        catch: storageError,
      });

      const record = Effect.fn("RequestSends.record")(function* (send: Send) {
        const opened = yield* log;
        yield* Effect.try({ try: () => opened.put(send), catch: storageError });
        yield* PubSub.publish(changes, send.checkout);

        return send;
      });

      /** Best effort: a Send that went out is never failed because its Span couldn't be stored. */
      const writeSpan = (input: SendInput, bytes: Uint8Array) =>
        Effect.gen(function* () {
          const context = yield* input.by.sessionId === undefined
            ? sessions.workspace(input.checkout)
            : sessions.session(input.by.sessionId);

          yield* store.ingest({
            bytes,
            signal: "traces",
            contentType: "application/json",
            context,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("requests: the Send's root Span wasn't stored", cause)
          )
        );

      const denied = (input: SendInput, prepared: PreparedRequest, mask: Masker, message: string) =>
        record(
          sendRecord(
            {
              id: crypto.randomUUID(),
              checkout: input.checkout,
              ref: prepared.ref,
              ...(prepared.environment === undefined
                ? undefined
                : { environment: prepared.environment }),
              method: prepared.request.method,
              url: prepared.request.url,
              headers: prepared.headers,
              ...(prepared.request.body === undefined
                ? undefined
                : { body: prepared.request.body }),
              outcome: "denied",
              errorMessage: message,
              traceId: null,
              startedAt: new Date(),
              durationMs: 0,
              by: input.by,
            },
            mask
          )
        );

      const exchange = Effect.fn("RequestSends.exchange")(function* (
        input: SendInput,
        prepared: PreparedRequest,
        mask: Masker,
        trace: SendTraceContext
      ) {
        const id = crypto.randomUUID();
        const startedAt = new Date();
        const startNano = nowNano();
        const started = performance.now();

        const transmission = yield* Effect.promise(() =>
          transmit(
            {
              method: prepared.request.method,
              url: prepared.request.url,
              headers: trace.headers,
              ...(prepared.request.body === undefined
                ? undefined
                : { body: prepared.request.body }),
            },
            options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }
          )
        );

        const durationMs = performance.now() - started;
        const response = transmission.response;
        const errorMessage = errorOf(transmission);

        const send = sendRecord(
          {
            id,
            checkout: input.checkout,
            ref: prepared.ref,
            ...(prepared.environment === undefined
              ? undefined
              : { environment: prepared.environment }),
            method: prepared.request.method,
            url: prepared.request.url,
            headers: trace.headers,
            ...(prepared.request.body === undefined ? undefined : { body: prepared.request.body }),
            ...(response === undefined ? undefined : { response }),
            outcome: transmission.outcome,
            ...(errorMessage === undefined ? undefined : { errorMessage }),
            traceId: trace.traceId,
            startedAt,
            durationMs,
            by: input.by,
          },
          mask
        );

        yield* writeSpan(
          input,
          rootSpanRequest({
            context: trace,
            method: send.method,
            url: send.url,
            ...(send.status === undefined ? undefined : { status: send.status }),
            outcome: send.outcome,
            ...(send.errorMessage === undefined ? undefined : { errorMessage: send.errorMessage }),
            sendId: id,
            startNano,
            endNano: startNano + BigInt(Math.round(durationMs * 1_000_000)),
          })
        );

        return yield* record(send);
      });

      const send = Effect.fn("RequestSends.send")(function* (input: SendInput) {
        const prepared = yield* Effect.promise(() =>
          prepare(input.checkout, input.target, input.environment, options)
        ).pipe(Effect.flatMap(Effect.fromResult));

        const mask = masker(prepared.secrets);

        if (input.by.kind === "agent") {
          const verdict = yield* runHooks(hooks, pending(input, prepared, mask, input.by));

          if (!verdict.allow) return yield* denied(input, prepared, mask, verdict.message);
        }

        return yield* exchange(input, prepared, mask, sendTraceContext(prepared.headers));
      });

      const page = (checkout: string, pageOptions?: PageOptions) =>
        Effect.flatMap(log, (opened) =>
          Effect.try({ try: () => opened.page(checkout, pageOptions), catch: storageError })
        );

      const get = (checkout: string, lookup: SendLookup) =>
        Effect.flatMap(log, (opened) =>
          Effect.try({ try: () => opened.get(checkout, lookup), catch: storageError })
        ).pipe(
          Effect.flatMap((found) =>
            found === undefined
              ? Effect.fail(
                  notFound(
                    Match.valueTags(lookup, {
                      ById: ({ id }) => id,
                      ByTrace: ({ traceId }) => `for trace ${traceId}`,
                    })
                  )
                )
              : Effect.succeed(found)
          )
        );

      const watch = (checkout: string) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(changes);
            const initial = yield* page(checkout);

            return Stream.concat(
              Stream.succeed(initial.sends),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((key) => key === checkout),
                Stream.mapEffect(() => Effect.map(page(checkout), (result) => result.sends))
              )
            );
          })
        );

      const registerPreSend = Effect.fnUntraced(function* (hook: PreSendHook) {
        hooks.add(hook);
        yield* Effect.addFinalizer(() => Effect.sync(() => hooks.delete(hook)));
      });

      return RequestSends.of({ send, page, watch, get, registerPreSend });
    })
  );
