import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DomainEvent, TraceAvailability, TurnItem } from "@polaris/protocol";
import { Effect } from "effect";
import { patchTurn } from "../store/model.ts";
import { EventStore } from "../store/EventStore.ts";
import { TraceRuntime } from "./runtime.ts";
import { TraceSessions } from "./sessions.ts";
import { TraceTokenVault } from "./tokens.ts";
import { TEST_SESSION, TEST_WORKSPACE } from "./testing.ts";
import { at, commit, seed, turn, withAuthority } from "./authority.testing.ts";

const tokenOf = (endpoint: string) => endpoint.split("/").at(-1)!;

const listening = TraceAvailability.cases.Listening.make({});

test.each(["archived", "failed"] as const)(
  "dormancy and graceful restart preserve the endpoint, but %s revokes it without a request",
  (endedState) =>
    withAuthority(async (root, layer) => {
      const endpoint = await Effect.runPromise(
        Effect.gen(function* () {
          yield* seed(root);
          const runtime = yield* TraceRuntime;
          yield* runtime.setAvailability(listening);
          const env = yield* runtime.environment(TEST_SESSION, {});
          yield* commit([
            DomainEvent.cases.SessionStateChanged.make({
              sessionId: TEST_SESSION,
              state: "dormant",
              reason: null,
            }),
          ]);
          yield* Effect.sleep(10);
          expect(
            yield* runtime.authenticate(tokenOf(env.OTEL_EXPORTER_OTLP_ENDPOINT!))
          ).not.toBeNull();

          return env.OTEL_EXPORTER_OTLP_ENDPOINT!;
        }).pipe(Effect.provide(layer))
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* TraceRuntime;
          yield* runtime.setAvailability(listening);
          expect((yield* runtime.environment(TEST_SESSION, {})).OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
            endpoint
          );
          expect(yield* runtime.authenticate(tokenOf(endpoint))).not.toBeNull();
          yield* commit([
            DomainEvent.cases.SessionStateChanged.make({
              sessionId: TEST_SESSION,
              state: endedState,
              reason: null,
            }),
          ]);
          yield* Effect.sleep(30);
          const vault = new TraceTokenVault(join(root, "tokens.json"));
          expect(vault.authenticate(tokenOf(endpoint))).toBeNull();
          expect(vault.userExported(TEST_SESSION)).toBeUndefined();
        }).pipe(Effect.provide(layer))
      );
    })
);

test("Workspace removal revokes terminal and session bindings and prunes exported entries", () =>
  withAuthority(async (root, layer) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed(root);
        const runtime = yield* TraceRuntime;
        yield* runtime.setAvailability(listening);
        const session = yield* runtime.environment(TEST_SESSION, {});
        const terminal = yield* runtime.terminalEnvironment(root, {});
        yield* commit([DomainEvent.cases.WorkspaceRemoved.make({ workspaceId: TEST_WORKSPACE })]);
        yield* Effect.sleep(30);
        const vault = new TraceTokenVault(join(root, "tokens.json"));
        expect(vault.authenticate(tokenOf(session.OTEL_EXPORTER_OTLP_ENDPOINT!))).toBeNull();
        expect(vault.authenticate(tokenOf(terminal.OTEL_EXPORTER_OTLP_ENDPOINT!))).toBeNull();
        expect(vault.userExported(TEST_SESSION)).toBeUndefined();
        expect(
          yield* Effect.promise(() => readFile(join(root, "tokens.json"), "utf8"))
        ).not.toContain(tokenOf(terminal.OTEL_EXPORTER_OTLP_ENDPOINT!));
      }).pipe(Effect.provide(layer))
    );
  }));

test("subfolder sessions share terminal checkout authority and update Turn intervals without rereading history", () =>
  withAuthority(async (root, layer) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed(root);
        const store = yield* EventStore;
        const sessions = yield* TraceSessions;
        const first = turn(0);
        yield* commit([DomainEvent.cases.TurnStarted.make({ turn: first })]);
        const initial = yield* sessions.session(TEST_SESSION);
        expect(initial.checkout).toBe((yield* sessions.workspace(root)).checkout);
        // Make SQL history unavailable after the cache is primed; attribution must follow the live model.
        let allowHistory = true;

        const guarded = {
          ...store,
          readTurns: (options: Parameters<typeof store.readTurns>[0]) =>
            allowHistory ? store.readTurns(options) : Effect.die("Unexpected historical Turn read"),
        };

        const cached = yield* Effect.gen(function* () {
          const current = yield* TraceSessions;
          yield* current.session(TEST_SESSION);

          return current;
        }).pipe(Effect.provide(TraceSessions.layer), Effect.provideService(EventStore, guarded));

        allowHistory = false;

        for (let i = 0; i < 10; i++) {
          yield* commit([
            DomainEvent.cases.TurnItemCompleted.make({
              sessionId: TEST_SESSION,
              turnId: first.id,
              item: TurnItem.cases.AssistantMessage.make({ id: `message-${i}`, text: "progress" }),
              subagentId: null,
            }),
          ]);
          expect((yield* cached.session(TEST_SESSION)).turns).toEqual(initial.turns);
        }

        const ended = patchTurn(first, {
          status: "completed",
          endedAt: new Date(Date.parse(at) + 500).toISOString(),
        });

        yield* commit([
          DomainEvent.cases.TurnEnded.make({ turn: ended }),
          DomainEvent.cases.TurnStarted.make({ turn: turn(1) }),
        ]);
        const after = yield* cached.session(TEST_SESSION);
        expect(after.turns).toHaveLength(2);
        expect(after.turns[0]?.end).toBe(
          (BigInt(Date.parse(ended.endedAt!)) * 1_000_000n).toString()
        );
        expect(after.turns[1]?.turn.id).toBe(turn(1).id);
      }).pipe(Effect.provide(layer))
    );
  }));
