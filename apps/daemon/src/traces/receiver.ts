import { basename } from "node:path";
import { Effect, Layer, Option, Redacted, Schema, type Scope } from "effect";
import { TraceAvailability } from "@polaris/protocol";
import { MAX_BODY_BYTES } from "./ingest.ts";
import { TraceRuntime, TRACE_PORT } from "./runtimeService.ts";
import type { TraceStore } from "./storeService.ts";
import type { ForwardQueue } from "./forwardQueue.ts";
import { cacheDaemonBuild } from "../transport/lazy.ts";

const decodeListenError = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));

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
  /** Production supplies the shared lazy graph; standalone receivers capture their provided services. */
  readonly handler?: Effect.Effect<(request: Request) => Promise<Response>>;
  readonly forwarding?: ForwardQueue;
  readonly owner?: (port: number) => Promise<string | null>;
}

export const traceReceiver = (options: ReceiverOptions = {}) =>
  Effect.gen(function* () {
    const runtime = yield* TraceRuntime;
    const context = yield* Effect.context<TraceRuntime | TraceStore | Scope.Scope>();

    const handler = yield* cacheDaemonBuild(
      options.handler ??
        Effect.gen(function* () {
          const { traceRequestHandler } = yield* Effect.promise(
            () => import("./receiverHandler.ts")
          );

          return yield* traceRequestHandler(options);
        }).pipe(Effect.provide(context))
    );

    const fetch = (request: Request) =>
      Effect.runPromise(Effect.flatMap(handler, (handle) => Effect.promise(() => handle(request))));

    const port = options.port ?? TRACE_PORT;
    let stopping = false;
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
