import { Effect, Option, Result, Schema } from "effect";
import { loopbackRequest } from "../transport/loopbackHttp.ts";
import { IngestError, MAX_BODY_BYTES } from "./ingest.ts";
import { TraceRuntime, TRACE_PORT } from "./runtimeService.ts";
import { TraceSettings } from "./settings.ts";
import { ForwardQueue } from "./forwardQueue.ts";
import { forwardReceived } from "./forwarding.ts";
import { TraceStore } from "./storeService.ts";
import { TRACE_TOKEN_PATTERN } from "./tokens.ts";

/** A total deadline bounds even bodies that keep the idle timeout alive. */
const body = async (request: Request): Promise<Uint8Array> => {
  const length = request.headers.get("content-length");

  if (length !== null && Number(length) > MAX_BODY_BYTES) {
    await request.body?.cancel();
    throw new IngestError(413, "OTLP body exceeds 4 MiB");
  }

  const reader = request.body?.getReader();

  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;

  let deadline: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => {
      reject(new IngestError(408, "OTLP body deadline exceeded"));
      void reader.cancel().catch(() => {});
    }, 5000);
  });

  try {
    while (true) {
      const part = await Promise.race([reader.read(), expired]);

      if (part.done) break;
      const chunk = Schema.decodeUnknownSync(Schema.Uint8Array)(part.value);
      size += chunk.byteLength;

      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new IngestError(413, "OTLP body exceeds 4 MiB");
      }

      chunks.push(chunk);
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
};

const refuse = (request: Request, status: number): Response => {
  void request.body?.cancel().catch(() => {});

  return new Response(null, { status, headers: { connection: "close" } });
};

const acknowledge = (type: string) =>
  new Response(type === "application/json" ? "{}" : new Uint8Array(), {
    status: 200,
    headers: { "content-type": type },
  });

import type { ReceiverOptions } from "./receiver.ts";

export const traceRequestHandler = (options: ReceiverOptions = {}) =>
  Effect.gen(function* () {
    const runtime = yield* TraceRuntime;
    const store = yield* TraceStore;
    const settings = yield* Effect.serviceOption(TraceSettings);
    const forwarding = options.forwarding ?? new ForwardQueue();

    const unsubscribe = Option.isSome(settings)
      ? settings.value.subscribe((id) => forwarding.cancel(id))
      : () => {};

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribe();
        forwarding.close();
      })
    );
    const port = options.port ?? TRACE_PORT;
    let inFlight = 0;
    let stopping = false;
    const tokens = new Set<string>();

    const fetch = async (request: Request): Promise<Response> => {
      let admitted: string | undefined;

      try {
        if (!loopbackRequest(request, { port, localhost: true, rejectOrigin: true }))
          return refuse(request, 403);

        if (request.method !== "POST") return refuse(request, 405);

        const path = new RegExp(`^/otlp/(${TRACE_TOKEN_PATTERN})/v1/(traces|logs)$`).exec(
          new URL(request.url).pathname
        );

        if (path === null) return refuse(request, 404);

        const context = await Effect.runPromise(runtime.authenticate(path[1]!));

        if (context === null) return refuse(request, 401);
        const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();

        if (
          (type !== "application/json" && type !== "application/x-protobuf") ||
          request.headers.has("content-encoding")
        )
          return refuse(request, 415);
        const token = path[1]!;

        if (stopping || inFlight >= 2 || tokens.has(token)) return refuse(request, 429);
        tokens.add(token);
        admitted = token;
        inFlight++;
        const bytes = await body(request);
        const signal = path[2] === "logs" ? "logs" : "traces";

        const storeEnabled = await forwardReceived(
          Option.getOrNull(settings),
          forwarding,
          context,
          signal,
          request,
          bytes
        );

        if (!storeEnabled) return acknowledge(type);

        const result = await Effect.runPromise(
          Effect.result(
            store.ingest({
              bytes,
              signal,
              contentType: type,
              context,
            })
          )
        );

        if (Result.isFailure(result)) return refuse(request, result.failure.status);

        return acknowledge(type);
      } catch (cause) {
        return refuse(request, cause instanceof IngestError ? cause.status : 503);
      } finally {
        if (admitted !== undefined) {
          tokens.delete(admitted);
          inFlight--;
        }
      }
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopping = true;
      })
    );

    return fetch;
  });
