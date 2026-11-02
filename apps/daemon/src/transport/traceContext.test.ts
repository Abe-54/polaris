/** A handler Span's parent comes from the request's `traceparent` header through the real server. */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { HostTarget, makeHostConnection } from "@polaris/client";
import { SessionId, TerminalLaunch, TRACEPARENT_HEADER } from "@polaris/protocol";
import { localEndpoint } from "@polaris/protocol/endpoint";
import { Effect, Option, type Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { ServerRpcs } from "./rpcs.ts";
import { startServer } from "./server.ts";
import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";

const homes: string[] = [];

// Each server gets its own home: Windows releases a closed pipe's name only after a while.
const freshHome = () => {
  const home = newTempDir("tctx-", { short: true });
  homes.push(home);

  return home;
};

afterEach(async () => {
  for (const home of homes.splice(0)) await removeTempDirSettled(home);
});

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

const PARENT = "00f067aa0ba902b7";

/** Echoes the handler Span's parent as `[traceId, spanId]`, or `[]` without one. */
const parentEcho = ServerRpcs.toLayerHandler("session.terminalCommand", () =>
  Effect.map(Effect.currentSpan, (span) => {
    const parent = Option.getOrUndefined(span.parent);

    return new TerminalLaunch({
      argv: parent === undefined ? [] : [parent.traceId, parent.spanId],
      cwd: "/",
      env: {},
    });
  }).pipe(Effect.orDie)
);

const parentOf = (headers: Record<string, string>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const home = freshHome();
        yield* startServer({
          socketPath: localEndpoint(home),
          lockPath: join(home, "daemon.lock"),
          root: home,
          handlers: parentEcho,
        });

        const connection = yield* makeHostConnection({
          key: "local",
          name: "Local",
          target: HostTarget.Local({ socketPath: localEndpoint(home) }),
          identity: {
            name: "polaris-test",
            version: "0.0.0",
            deviceLabel: "Test",
            // A Windows Host refuses a Client without host.any-platform (ADR 0059).
            capabilities: ["host.any-platform"],
          },
        });

        const session = yield* connection.awaitSession;

        // The Client call runs inside its own Effect Span, which Effect's RPC client would propagate.
        return yield* session.client["session.terminalCommand"]({
          sessionId: SessionId.make("s"),
        }).pipe(RpcClient.withHeaders(headers), Effect.withSpan("client.call"));
      }) satisfies Effect.Effect<unknown, unknown, Scope.Scope>
    )
  ).then((launch) => launch?.argv);

test("traceparent makes the Daemon's handler Span its child", async () => {
  expect(await parentOf({ [TRACEPARENT_HEADER]: `00-${TRACE}-${PARENT}-01` })).toEqual([
    TRACE,
    PARENT,
  ]);
});

test("without a valid traceparent the handler Span has no Client parent", async () => {
  expect(await parentOf({})).toEqual([]);
  expect(await parentOf({ [TRACEPARENT_HEADER]: `00-${"0".repeat(32)}-${PARENT}-01` })).toEqual([]);
});
