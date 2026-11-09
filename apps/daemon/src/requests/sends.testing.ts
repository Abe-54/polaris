/** A RequestSends over a trace fixture's real store, receiver and sessions. */
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { TraceSessions } from "../traces/sessionsService.ts";
import { TraceStore } from "../traces/storeService.ts";
import type { TraceFixture } from "../traces/testing.ts";
import { RequestSends, type RequestSendsOptions } from "./sendsService.ts";

export const withSends = (
  fixture: TraceFixture,
  run: (sends: RequestSends["Service"]) => Promise<void>,
  options: RequestSendsOptions = {}
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sends = yield* RequestSends;
        yield* Effect.promise(() => run(sends));
      }).pipe(
        Effect.provide(
          RequestSends.layerAt(join(fixture.root, "requests.sqlite"), options).pipe(
            Layer.provide(Layer.succeed(TraceStore, fixture.store)),
            Layer.provide(Layer.succeed(TraceSessions, fixture.sessions))
          )
        )
      )
    )
  );

/** A server on a free loopback port for the length of `run`. */
export const withServer = async (
  fetch: (request: Request) => Response | Promise<Response>,
  run: (base: string) => Promise<void>
) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });

  try {
    await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop(true);
  }
};

/** A loopback port with nothing listening on it. */
export const closedPort = async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);

  return port;
};
