import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import {
  Command,
  CommandId,
  ExtensionDaemonRpcs,
  GRANT_KINDS,
  NotGranted,
  SessionId,
} from "@polaris/protocol";
import { Effect, Match, Predicate, Redacted, Schema, Stream } from "effect";
import fc from "fast-check";
import {
  ExtensionsTraceEvent,
  decodeExtensionsTrace,
  replayExtensions,
} from "../../../../packages/spec/scripts/extensions-replay/index.ts";
import { shortTemp } from "../platform/testing.ts";
import { startServer } from "../transport/server.ts";
import { pbtRuns, pbtSeed, pbtTimeout } from "./pbt.ts";

const runs = pbtRuns(20);

const identity = {
  clientName: "model",
  clientVersion: "0",
  deviceLabel: "model",
  capabilities: [],
};

const step = fc.record({
  action: fc.constantFrom("hello", "call", "revoke", "close"),
  connection: fc.integer({ min: 1, max: 3 }),
  pairing: fc.integer({ min: 0, max: 3 }),
  need: fc.constantFrom("client", "read", "turn"),
});

type Step = typeof step extends fc.Arbitrary<infer A> ? A : never;

const isNotGranted = Schema.is(NotGranted);

const observed = (error: { readonly _tag: string }): string => {
  if (isNotGranted(error))
    return error.needed === null ? "not-for-extensions" : `refused:${error.needed}`;

  return Predicate.isTagged(error, "CommandRejected") ? "allowed" : "dropped";
};

const exercise = (
  grants: ReadonlyArray<ReadonlyArray<(typeof GRANT_KINDS)[number]>>,
  steps: ReadonlyArray<Step>
) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(shortTemp("pl-ext-pbt-"))),
      (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true }))
    );

    const server = yield* startServer({
      root,
      socketPath: join(root, "d.sock"),
      lockPath: join(root, "d.lock"),
    });

    const connect = () =>
      Effect.gen(function* () {
        const transport = yield* socketTransport(server.socketPath);
        const connection = yield* connectRpcWith(ExtensionDaemonRpcs, transport);

        return { ...connection, close: transport.close };
      });

    const desktop = yield* connect();
    yield* desktop.client.hello(identity);

    const issued = yield* Effect.forEach(grants, (grant, index) =>
      desktop.client["extensions.pair"]({ name: `Extension ${index}`, grant })
    );

    const clients = yield* Effect.forEach([1, 2, 3], connect);
    const closed = new Set<number>();
    const bound = new Map<number, number>();

    const trace: Array<ExtensionsTraceEvent> = issued.map((_, pairing) =>
      ExtensionsTraceEvent.cases.Pair.make({ pairing, grant: grants[pairing]! })
    );

    const record = (event: ExtensionsTraceEvent) => {
      trace.push(event);
      replayExtensions(
        decodeExtensionsTrace({
          format: "extensions-v1",
          provenance: "runtime-socket",
          events: trace,
        })
      );
    };

    const helloStep = Effect.fn(function* (op: Step) {
      const client = clients[op.connection - 1]!;

      if (closed.has(op.connection)) return;
      const token = issued[op.pairing]?.token ?? `pol_ext_${"Z".repeat(43)}`;

      const payload =
        op.pairing === 3 ? identity : { ...identity, extensionToken: Redacted.make(token) };

      const outcome = yield* client.client.hello(payload).pipe(
        Effect.match({
          onSuccess: () => "ok" as const,
          onFailure: (error) => {
            expect(error._tag).toBe("ExtensionTokenRejected");

            return "refused" as const;
          },
        })
      );

      record(
        ExtensionsTraceEvent.cases.Hello.make({
          connection: op.connection,
          pairing: op.pairing === 3 ? null : op.pairing,
          observed: outcome,
        })
      );

      if (outcome === "refused") {
        closed.add(op.connection);
        yield* Effect.flip(client.lost);
      } else if (op.pairing < 2) bound.set(op.connection, op.pairing);
    });

    const callStep = Effect.fn(function* (op: Step, index: number) {
      const client = clients[op.connection - 1]!;

      const call = Match.value(op.need).pipe(
        Match.when("client", () => Effect.asVoid(client.client["extensions.list"]())),
        Match.when("read", () =>
          Stream.runDrain(Stream.take(client.client.subscribeHost({ afterSequence: null }), 1))
        ),
        Match.when("turn", () =>
          Effect.asVoid(
            client.client.dispatch({
              commandId: CommandId.make(`pbt-${index}`),
              command: Command.cases.SendTurn.make({
                sessionId: SessionId.make("s"),
                prompt: "hi",
                attachments: [],
              }),
            })
          )
        ),
        Match.exhaustive
      );

      const outcome = yield* call.pipe(
        Effect.match({ onSuccess: () => "allowed", onFailure: observed })
      );

      record(
        ExtensionsTraceEvent.cases.Call.make({
          connection: op.connection,
          need: op.need,
          observed: outcome,
        })
      );
    });

    const revokeStep = Effect.fn(function* (op: Step) {
      const id = op.pairing % 2;
      yield* desktop.client["extensions.revoke"]({ id: issued[id]!.pairing.id });
      record(ExtensionsTraceEvent.cases.Revoke.make({ pairing: id, observed: "ok" }));

      for (const [connection, pairing] of bound) {
        if (pairing === id) {
          closed.add(connection);
          yield* Effect.flip(clients[connection - 1]!.lost);
        }
      }
    });

    const closeStep = Effect.fn(function* (op: Step) {
      const client = clients[op.connection - 1]!;
      yield* client.close;
      yield* Effect.flip(client.lost);
      closed.add(op.connection);
      record(ExtensionsTraceEvent.cases.Close.make({ connection: op.connection }));
    });

    for (const [index, op] of steps.entries()) {
      yield* Match.value(op.action).pipe(
        Match.when("hello", () => helloStep(op)),
        Match.when("call", () => callStep(op, index)),
        Match.when("revoke", () => revokeStep(op)),
        Match.when("close", () => closeStep(op)),
        Match.exhaustive
      );
    }
  });

test(
  "socket hello, Grant calls and revocation agree with the connection reference",
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.subarray([...GRANT_KINDS]), { minLength: 2, maxLength: 2 }),
        fc.array(step, { minLength: 15, maxLength: 30 }),
        (grants, steps) =>
          Effect.runPromise(
            Effect.scoped(exercise(grants, steps)).pipe(Effect.timeout("10 seconds"))
          )
      ),
      { numRuns: runs, ...pbtSeed() }
    );
  },
  pbtTimeout(runs, 500)
);
