import { basename } from "node:path";
import { Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { TraceAvailability } from "@polaris/protocol";
import { loopbackRequest } from "../transport/loopbackHttp.ts";
import { IngestError, MAX_BODY_BYTES } from "./ingest.ts";
import { TraceRuntime, TRACE_PORT } from "./runtime.ts";
import { TraceStore } from "./store.ts";

const ListenError = Schema.Struct({ code: Schema.String });

const decodeListenError = Schema.decodeUnknownOption(ListenError);

/** Bounded body consumption also applies to refusals, preserving HTTP/1 keep-alive on Bun 1.3. */
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

  try {
    while (true) {
      const part = await reader.read();

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

const refuse = async (request: Request, status: number): Promise<Response> => {
  try {
    await body(request);
  } catch (cause) {
    if (cause instanceof IngestError) status = cause.status;
  }

  return new Response(null, { status });
};

const listenerOwner = async (port: number): Promise<string | null> => {
  try {
    const { listenerOwners } = await import("../data/listener.ts");

    const owners = await listenerOwners({
      hostname: "127.0.0.1",
      port,
      database: "",
      username: "",
      password: Redacted.make(""),
      tls: false,
    });

    return owners.length === 0
      ? null
      : owners
          .map((owner) => `${basename(owner.executable) || "process"} (PID ${owner.pid})`)
          .join(", ");
  } catch {
    return null;
  }
};

export interface ReceiverOptions {
  /** Tests may use an isolated fixed port. Production always uses TRACE_PORT, including collisions. */
  readonly port?: number;
  readonly owner?: (port: number) => Promise<string | null>;
}

export const traceReceiver = (options: ReceiverOptions = {}) =>
  Effect.gen(function* () {
    const runtime = yield* TraceRuntime;
    const store = yield* TraceStore;
    const port = options.port ?? TRACE_PORT;
    let inFlight = 0;
    let stopping = false;

    const fetch = async (request: Request): Promise<Response> => {
      if (stopping || inFlight >= 2) {
        await request.body?.cancel().catch(() => {});

        return new Response(null, { status: 429, headers: { connection: "close" } });
      }

      inFlight++;

      try {
        if (!loopbackRequest(request, { port, localhost: true, rejectOrigin: true }))
          return await refuse(request, 403);

        if (request.method !== "POST") return await refuse(request, 405);

        const path = /^\/otlp\/([a-f0-9]{64})\/v1\/(traces|logs)$/.exec(
          new URL(request.url).pathname
        );

        if (path === null) return await refuse(request, 404);

        const context = await Effect.runPromise(runtime.authenticate(path[1]!));

        if (context === null) return await refuse(request, 401);
        const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();

        if (
          (type !== "application/json" && type !== "application/x-protobuf") ||
          request.headers.has("content-encoding")
        )
          return await refuse(request, 415);
        const bytes = await body(request);

        const result = await Effect.runPromise(
          Effect.result(
            store.ingest({
              bytes,
              signal: path[2] === "logs" ? "logs" : "traces",
              contentType: type,
              context,
            })
          )
        );

        if (Result.isFailure(result)) return new Response(null, { status: result.failure.status });

        return new Response(type === "application/json" ? "{}" : new Uint8Array(), {
          status: 200,
          headers: { "content-type": type },
        });
      } catch (cause) {
        return new Response(null, { status: cause instanceof IngestError ? cause.status : 503 });
      } finally {
        inFlight--;
      }
    };

    const started = yield* Effect.try({
      try: () =>
        Bun.serve({
          hostname: "127.0.0.1",
          port,
          maxRequestBodySize: MAX_BODY_BYTES,
          idleTimeout: 10,
          fetch,
        }),
      catch: (cause) => cause,
    }).pipe(Effect.result);

    if (Result.isFailure(started)) {
      const error = decodeListenError(started.failure);
      const conflict = Option.isSome(error) && error.value.code === "EADDRINUSE";

      const owner = conflict
        ? yield* Effect.promise(() => (options.owner ?? listenerOwner)(port))
        : null;

      yield* runtime.setAvailability(
        TraceAvailability.cases.Unavailable.make({
          code: conflict ? "EADDRINUSE" : "E-TRACE-LISTEN",
          message: conflict
            ? `Traces is unavailable: port ${port} is in use${owner === null ? "." : ` by ${owner}.`}`
            : `Traces could not listen on 127.0.0.1:${port}.`,
          owner,
        })
      );

      return null;
    }

    const server = started.success;
    yield* runtime.setAvailability(TraceAvailability.cases.Listening.make({}));
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        stopping = true;
        await server.stop(true);
      })
    );

    return server;
  });

export const TraceReceiverLive = Layer.effectDiscard(traceReceiver());
