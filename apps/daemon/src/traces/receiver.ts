import { basename } from "node:path";
import { Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { TraceAvailability } from "@polaris/protocol";
import { loopbackRequest } from "../transport/loopbackHttp.ts";
import { IngestError, MAX_BODY_BYTES } from "./ingest.ts";
import { TraceRuntime, TRACE_PORT } from "./runtime.ts";
import { TraceSettings } from "./settings.ts";
import { ForwardQueue } from "./forwardQueue.ts";
import { forwardReceived } from "./forwarding.ts";
import { TraceStore } from "./store.ts";

const ListenError = Schema.Struct({ code: Schema.String });

const decodeListenError = Schema.decodeUnknownOption(ListenError);

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
  readonly forwarding?: ForwardQueue;
  readonly owner?: (port: number) => Promise<string | null>;
}

export const traceReceiver = (options: ReceiverOptions = {}) =>
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

        const path = /^\/otlp\/([a-f0-9]{64})\/v1\/(traces|logs)$/.exec(
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

    let server: ReturnType<typeof Bun.serve> | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 250;

    const bind = async (): Promise<void> => {
      if (stopping) return;

      try {
        server = Bun.serve({
          hostname: "127.0.0.1",
          port,
          maxRequestBodySize: MAX_BODY_BYTES,
          idleTimeout: 10,
          fetch,
        });
      } catch (cause) {
        const error = decodeListenError(cause);
        const conflict = Option.isSome(error) && error.value.code === "EADDRINUSE";
        const owner = conflict ? await (options.owner ?? listenerOwner)(port) : null;

        if (stopping) return;
        await Effect.runPromise(
          runtime.setAvailability(
            TraceAvailability.cases.Unavailable.make({
              code: conflict ? "EADDRINUSE" : "E-TRACE-LISTEN",
              message: conflict
                ? `Traces is unavailable: port ${port} is in use${owner === null ? "." : ` by ${owner}.`}`
                : `Traces could not listen on 127.0.0.1:${port}.`,
              owner,
            })
          )
        );
        retry = setTimeout(() => {
          void bind();
        }, delay);
        retry.unref();
        delay = Math.min(delay * 2, 30_000);

        return;
      }

      await Effect.runPromise(runtime.setAvailability(TraceAvailability.cases.Listening.make({})));
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        stopping = true;
        clearTimeout(retry);
        await server?.stop(true);
      })
    );
    yield* Effect.promise(bind);

    return server;
  });

export const TraceReceiverLive = Layer.effectDiscard(traceReceiver());
