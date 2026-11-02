/**
 * Model-based tests generated from the Connection State machine: `xstate/graph`
 * walks the test model (`@polaris/client/testing`) and every path is replayed
 * against a real HostConnection talking to an in-process Daemon server, with
 * a scripted connector (each attempt connects or fails as the path says) and
 * a TestClock. After every step the HostConnection's status (Connection State,
 * attempt, failure reason, time to the next attempt) and what its loop is
 * doing must equal the model's.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type ConnectFailure,
  type Connector,
  HostTarget,
  makeHostConnection,
  socketTransport,
} from "@polaris/client";
import {
  type ConnectionModel,
  type ConnectionStep,
  connectionPaths,
  FAILURES,
  initialConnectionModel,
  LOST,
  MODEL_POLICY,
  type ObservedConnection,
  observeConnectionModel,
  stepConnection,
} from "@polaris/client/testing";
import { Clock, Effect, Option, Queue, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";
import { startServer } from "./server.ts";
import { localEndpoint } from "@polaris/protocol/endpoint";
import { shortTemp } from "../platform/testing.ts";

/** How the next attempt ends: it connects (none) or fails with the failure. */
type Outcome = Option.Option<ConnectFailure>;

const identity = {
  name: "polaris-test",
  version: "0.0.0",
  deviceLabel: "Model",
  // A windows-x64 Host answers a Client without it with a newer protocol (ADR 0059).
  capabilities: ["host.any-platform" as const],
};

const replay = (steps: ReadonlyArray<ConnectionStep>) =>
  Effect.gen(function* () {
    // Short path: Unix socket paths are limited to ~104 bytes on macOS.
    const home = mkdtempSync(shortTemp("plc-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(home, { recursive: true, force: true }))
    );
    const socketPath = localEndpoint(home);
    yield* startServer({ socketPath, lockPath: join(home, "daemon.lock"), root: home });

    const outcomes = yield* Queue.unbounded<Outcome>();
    let awaiting = false;
    let live: { readonly close: Effect.Effect<void> } | null = null;

    const connector: Connector = Effect.gen(function* () {
      awaiting = true;

      const outcome = yield* Queue.take(outcomes).pipe(
        Effect.ensuring(Effect.sync(() => (awaiting = false)))
      );

      if (Option.isSome(outcome)) return yield* Effect.fail(outcome.value);
      const transport = yield* socketTransport(socketPath);
      live = transport;

      return { ...transport, diagnose: Effect.succeed(LOST) };
    });

    const conn = yield* makeHostConnection({
      key: "model",
      name: "Model",
      target: HostTarget.Local({ socketPath }),
      identity,
      policy: MODEL_POLICY,
      connector,
    });

    const observed = Effect.gen(function* () {
      const status = yield* SubscriptionRef.get(conn.status);
      const now = yield* Clock.currentTimeMillis;
      const phase = awaiting ? "attempting" : status.state === "connected" ? "live" : "waiting";

      return {
        state: status.state,
        attempt: status.attempt,
        failure: status.failure?.reason ?? null,
        nextAttemptIn:
          phase === "waiting" && status.nextAttemptAt !== null ? status.nextAttemptAt - now : null,
        phase,
      } satisfies ObservedConnection;
    });

    const settle = (expected: ObservedConnection, done: ReadonlyArray<ConnectionStep>) =>
      Effect.gen(function* () {
        const deadline = Date.now() + 3000;

        while (true) {
          const actual = yield* observed;

          if (Bun.deepEquals(actual, expected)) return;

          if (Date.now() > deadline) {
            const path = done.map((s) => (s.type === "fail" ? `fail(${s.reason})` : s.type));

            return yield* Effect.die(
              new Error(
                `after ${path.join(" → ") || "start"}: the HostConnection shows ${JSON.stringify(actual)}, the machine ${JSON.stringify(expected)}`
              )
            );
          }

          // Real time: the TestClock only moves when a step moves it.
          yield* Effect.promise(() => Bun.sleep(1));
        }
      });

    const drive = (model: ConnectionModel, step: ConnectionStep) => {
      switch (step.type) {
        case "connect":
          return Queue.offer(outcomes, Option.none());
        case "fail":
          return Queue.offer(outcomes, Option.some(FAILURES[step.reason]));
        case "drop":
          return live?.close ?? Effect.die(new Error("nothing to drop"));
        case "retry":
          return conn.retryNow;
        case "elapse":
          return TestClock.adjust(model.machine.context.delay ?? 0);
        case "tick":
          return TestClock.adjust(MODEL_POLICY.restartGraceMs);
      }
    };

    let model = initialConnectionModel();
    const done: Array<ConnectionStep> = [];
    yield* settle(observeConnectionModel(model), done);

    for (const step of steps) {
      const next = stepConnection(model, step);
      expect(next).not.toBe(model);
      yield* drive(model, step);
      done.push(step);
      model = next;
      yield* settle(observeConnectionModel(model), done);
    }
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer({ warningDelay: "1 hour" })));

describe("Connection State machine vs HostConnection", () => {
  const paths = connectionPaths();

  const runAll = async (all: ReadonlyArray<ReadonlyArray<ConnectionStep>>) => {
    const queue = [...all];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (queue.length > 0) await Effect.runPromise(replay(queue.shift()!));
      })
    );
  };

  test(`${paths.states.length} shortest paths, one to every state`, async () => {
    await runAll(paths.states);
  }, 120_000);

  test(`${paths.transitions.length} transition paths, one per state-changing transition`, async () => {
    await runAll(paths.transitions);
  }, 300_000);
});
