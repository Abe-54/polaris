import { describe, expect, test } from "bun:test";
import type { DaemonClient } from "@polaris/client/rpc";
import {
  Command,
  CommandId,
  DEVELOPER_MODE_CAPABILITY,
  DeveloperMode,
  Dispatch,
  IngestSelfTraces,
  SELF_TRACES_CAPABILITY,
  SelfTraceRejected,
  type SelfTraceBatch,
  SessionId,
  type TraceContext,
  readTraceContext,
  WatchDeveloperMode,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect, Queue, Stream } from "effect";
import { RpcGroup, RpcTest } from "effect/rpc";
import { NotConnected } from "../runtime/hostConnection.ts";
import type { SelfTraceClient, SelfTraceHost } from "./developerMode.ts";
import { syncSelfTraces } from "./sync.ts";
import { openSelfTracer, MOBILE_SERVICE, type SelfTracer } from "./tracer.ts";
import app from "../../app.json";

class FakeHostRpcs extends RpcGroup.make(Dispatch, IngestSelfTraces, WatchDeveloperMode) {}

const mode = (effective: boolean, workspace = true) =>
  DeveloperMode.make({
    stored: effective,
    leases: 0,
    fromSource: false,
    effective,
    polarisWorkspaceId: workspace ? WorkspaceId.make("w-polaris") : null,
    polarisWorkspaceSource: workspace ? "remote" : null,
  });

const steer = Command.cases.Steer.make({ sessionId: SessionId.make("s-1"), text: "go on" });

type FakeClient = SelfTraceClient & Pick<DaemonClient, "dispatch">;

type Live = ReturnType<SelfTraceHost<FakeClient>["live"]>;

interface FakeHost {
  readonly connection: SelfTraceHost<FakeClient>;
  /** The trace context each dispatch arrived with. */
  readonly dispatched: Array<TraceContext | null>;
  readonly ingested: Array<SelfTraceBatch>;
  readonly modes: Queue.Queue<DeveloperMode>;
  readonly setOnline: (online: boolean) => void;
  /** Answers the next ingestSelf with SelfTraceRejected. */
  rejectNext: boolean;
}

const fakeHost = (capabilities: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const modes = yield* Queue.unbounded<DeveloperMode>();

    const host: Omit<FakeHost, "connection" | "setOnline"> = {
      dispatched: [],
      ingested: [],
      modes,
      rejectNext: false,
    };

    const handlers = FakeHostRpcs.toLayer({
      dispatch: (_payload, { headers }) =>
        Effect.sync(() => {
          host.dispatched.push(readTraceContext((name) => headers[name]));

          return { sequence: null };
        }),
      "traces.ingestSelf": (batch) =>
        host.rejectNext
          ? Effect.fail(new SelfTraceRejected({ reason: "developer-mode-off", message: "off" }))
          : Effect.sync(() => {
              host.ingested.push(batch);

              return { accepted: batch.spans.length };
            }),
      "developerMode.watch": () => Stream.fromQueue(modes),
    });

    const client: FakeClient = yield* RpcTest.makeClient(FakeHostRpcs).pipe(
      Effect.provide(handlers)
    );

    const listeners = new Set<() => void>();
    let live: Live = null;
    let epoch = 0;

    const setOnline = (online: boolean) => {
      epoch += 1;
      live = online ? { epoch, client, capabilities } : null;

      for (const listener of listeners) listener();
    };

    const connection: FakeHost["connection"] = {
      hostId: "host-a",
      live: () => live,
      subscribe: (listener) => {
        listeners.add(listener);

        return () => listeners.delete(listener);
      },
      run: (use) =>
        live === null ? Promise.reject(new NotConnected("host-a")) : Effect.runPromise(use(client)),
    };

    setOnline(true);

    const fake: FakeHost = Object.assign(host, { connection, setOnline });

    return fake;
  });

const until = async (check: () => boolean) => {
  for (let tries = 0; tries < 200 && !check(); tries += 1) await Bun.sleep(5);

  expect(check()).toBe(true);
};

const timers = () => {
  const active = new Set<number>();
  let next = 0;

  return {
    active,
    runtime: {
      now: () => Date.now(),
      random: Math.random,
      every: () => {
        next += 1;
        const id = next;

        active.add(id);

        return () => {
          active.delete(id);
        };
      },
    },
  };
};

const dispatchSteer = (tracer: SelfTracer, host: FakeHost) =>
  host.connection.run((client) =>
    tracer.traced(
      "mobile.dispatch.Steer",
      {},
      client.dispatch({ commandId: CommandId.make("c-1"), command: steer })
    )
  );

const withHost = (
  capabilities: ReadonlyArray<string>,
  body: (host: FakeHost, tracer: SelfTracer, clock: ReturnType<typeof timers>) => Promise<void>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* fakeHost(capabilities);
        const clock = timers();
        const tracer = openSelfTracer(clock.runtime);
        const stop = syncSelfTraces([host.connection], tracer);

        yield* Effect.promise(() => body(host, tracer, clock).finally(stop));
      })
    )
  );

const BOTH = [DEVELOPER_MODE_CAPABILITY, SELF_TRACES_CAPABILITY];

describe("Mobile Self-Traces against a Host", () => {
  test("while Developer Mode is off, commands carry no context, nothing buffers and no timer runs", () =>
    withHost(BOTH, async (host, tracer, clock) => {
      await Effect.runPromise(Queue.offer(host.modes, mode(false)));
      await Bun.sleep(20);
      await dispatchSteer(tracer, host);
      tracer.start("mobile.feed.subscribe").end();
      await tracer.flush();

      expect(host.dispatched).toEqual([null]);
      expect(tracer.buffer.spans()).toBe(0);
      expect(host.ingested).toEqual([]);
      expect(clock.active.size).toBe(0);
    }));

  test("while on, a dispatch carries the traceparent of the Span ingestSelf then delivers", () =>
    withHost(BOTH, async (host, tracer) => {
      await Effect.runPromise(Queue.offer(host.modes, mode(true)));
      await until(() => tracer.on());
      await host.connection.run((client) =>
        tracer.traced(
          "mobile.connect",
          {},
          tracer.traced(
            "mobile.dispatch.Steer",
            {},
            client.dispatch({ commandId: CommandId.make("c-1"), command: steer })
          )
        )
      );
      await tracer.flush();

      const context = host.dispatched[0];
      expect(context).not.toBeNull();
      const [batch] = host.ingested;
      expect(batch?.service).toBe(MOBILE_SERVICE);
      const dispatch = batch?.spans.find((span) => span.name === "mobile.dispatch.Steer");
      const connect = batch?.spans.find((span) => span.name === "mobile.connect");
      expect(context?.traceparent).toBe(`00-${dispatch?.traceId}-${dispatch?.id}-01`);
      expect(dispatch?.parentId).toBe(connect?.id ?? "missing");
      expect(dispatch?.traceId).toBe(connect?.traceId ?? "missing");
      // The release in app.json, so the Daemon can compare spans across builds.
      expect(dispatch?.resource).toEqual({
        "service.name": MOBILE_SERVICE,
        "service.version": app.expo.version,
      });
    }));

  test("turning Developer Mode off drops the buffer, stops the timer and the propagation", () =>
    withHost(BOTH, async (host, tracer, clock) => {
      await Effect.runPromise(Queue.offer(host.modes, mode(true)));
      await until(() => tracer.on());
      expect(clock.active.size).toBe(1);
      tracer.start("mobile.feed.subscribe").end();

      await Effect.runPromise(Queue.offer(host.modes, mode(false)));
      await until(() => !tracer.on());
      await dispatchSteer(tracer, host);
      await tracer.flush();

      expect(tracer.buffer.spans()).toBe(0);
      expect(clock.active.size).toBe(0);
      expect(host.dispatched).toEqual([null]);
      expect(host.ingested).toEqual([]);
    }));

  test("a Host with Developer Mode on but no Polaris Workspace gets nothing", () =>
    withHost(BOTH, async (host, tracer) => {
      await Effect.runPromise(Queue.offer(host.modes, mode(true, false)));
      await Bun.sleep(20);

      expect(tracer.on()).toBe(false);
    }));

  test("a Host that doesn't announce Self-Traces is never asked for Developer Mode", () =>
    withHost([DEVELOPER_MODE_CAPABILITY], async (host, tracer) => {
      await Effect.runPromise(Queue.offer(host.modes, mode(true)));
      await Bun.sleep(20);

      expect(tracer.on()).toBe(false);
    }));

  test("Spans wait out an unreachable Host and are sent once it is back", () =>
    withHost(BOTH, async (host, tracer) => {
      await Effect.runPromise(Queue.offer(host.modes, mode(true)));
      await until(() => tracer.on());
      tracer.start("mobile.feed.subscribe").end();

      host.setOnline(false);
      await tracer.flush();
      expect(tracer.buffer.spans()).toBe(1);

      host.setOnline(true);
      await tracer.flush();
      expect(host.ingested.flatMap((batch) => batch.spans.map((span) => span.name))).toEqual([
        "mobile.feed.subscribe",
      ]);
    }));

  test("a batch the Host refuses is dropped, not retried", () =>
    withHost(BOTH, async (host, tracer) => {
      await Effect.runPromise(Queue.offer(host.modes, mode(true)));
      await until(() => tracer.on());
      tracer.start("mobile.feed.subscribe").end();
      host.rejectNext = true;
      await tracer.flush();
      host.rejectNext = false;
      await tracer.flush();

      expect(tracer.buffer.spans()).toBe(0);
      expect(host.ingested).toEqual([]);
    }));
});
