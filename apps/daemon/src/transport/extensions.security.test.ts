import { expect, test } from "bun:test";
import { join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import { ExtensionDaemonRpcs, ExtensionTokenRejected } from "@polaris/protocol";
import { Deferred, Effect, Exit, Fiber, Match, Redacted, Stream } from "effect";
import { startServer } from "./server.ts";
import { scopedTempDir } from "../platform/tempDir.testing.ts";
import { TEST_USER_KEY } from "./userAccess.testing.ts";

const identity = { clientName: "test", clientVersion: "0", deviceLabel: "test", capabilities: [] };

const hello = (token?: string) =>
  token === undefined ? identity : { ...identity, extensionToken: Redacted.make(token) };

const setup = Effect.gen(function* () {
  const root = yield* scopedTempDir("pl-ext-sec-", { short: true });

  const server = yield* startServer({
    root,
    socketPath: join(root, "d.sock"),
    lockPath: join(root, "d.lock"),
  });

  const connect = () =>
    Effect.flatMap(socketTransport(server.socketPath), (transport) =>
      connectRpcWith(ExtensionDaemonRpcs, transport)
    );

  const desktop = yield* connect();
  yield* desktop.client.hello({ ...hello(), ...TEST_USER_KEY });
  const paired = yield* desktop.client["extensions.pair"]({ name: "Raycast", grant: ["read"] });

  return { connect, desktop, paired };
});

test("a transport requiring tokens refuses missing hello and pre-hello RPCs", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* scopedTempDir("pl-ext-req-", { short: true });

        const server = yield* startServer({
          root,
          socketPath: join(root, "d.sock"),
          lockPath: join(root, "d.lock"),
          extensionTokenRequired: true,
        });

        const connect = () =>
          Effect.flatMap(socketTransport(server.socketPath), (transport) =>
            connectRpcWith(ExtensionDaemonRpcs, transport)
          );

        const missing = yield* connect();
        expect(yield* Effect.flip(missing.client.hello(hello()))).toEqual(
          new ExtensionTokenRejected({ reason: "missing" })
        );
        yield* Effect.flip(missing.lost).pipe(Effect.timeout("2 seconds"));
        const early = yield* connect();
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              early.client["extensions.pair"]({ name: "intruder", grant: ["read"] })
            )
          )
        ).toBe(true);
        yield* Effect.flip(early.lost).pipe(Effect.timeout("2 seconds"));
      })
    )
  );
});

test.each(["malformed", "unknown", "revoked"] as const)(
  "a %s token cannot fall back to Client authority",
  async (kind) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { connect, desktop, paired } = yield* setup;

          if (kind === "revoked")
            yield* desktop.client["extensions.revoke"]({ id: paired.pairing.id });

          const token = Match.value(kind).pipe(
            Match.when("malformed", () => "pol_ext_nope"),
            Match.when("unknown", () => `pol_ext_${"Z".repeat(43)}`),
            Match.when("revoked", () => paired.token),
            Match.exhaustive
          );

          const extension = yield* connect();
          expect(yield* Effect.flip(extension.client.hello(hello(token)))).toEqual(
            new ExtensionTokenRejected({ reason: kind })
          );
          expect(Exit.isFailure(yield* Effect.exit(extension.client["extensions.list"]()))).toBe(
            true
          );
          yield* Effect.flip(extension.lost).pipe(Effect.timeout("2 seconds"));
          expect(yield* desktop.client["extensions.list"]()).toHaveLength(1);
        })
      )
    );
  }
);

test.each(["hello", "request", "subscription"] as const)(
  "Client authority established by %s cannot become an Extension",
  async (first) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { connect, paired } = yield* setup;
          const client = yield* connect();
          const seen = yield* Deferred.make<void>();

          const feed =
            first === "subscription"
              ? yield* client.client.subscribeHost({ afterSequence: null }).pipe(
                  Stream.tap(() => Deferred.succeed(seen, undefined)),
                  Stream.runDrain,
                  Effect.exit,
                  Effect.forkScoped
                )
              : null;

          if (feed !== null) yield* Deferred.await(seen);
          else if (first === "hello") yield* client.client.hello(hello());
          else expect(yield* client.client["extensions.list"]()).toHaveLength(1);
          expect(Exit.isFailure(yield* Effect.exit(client.client.hello(hello(paired.token))))).toBe(
            true
          );
          yield* Effect.flip(client.lost).pipe(Effect.timeout("2 seconds"));

          if (feed !== null) expect(Exit.isFailure(yield* Fiber.join(feed))).toBe(true);
        })
      )
    );
  }
);

test("a bound Extension still authenticates every token-bearing hello", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { connect, paired } = yield* setup;
        const extension = yield* connect();
        yield* extension.client.hello(hello(paired.token));
        expect(
          Exit.isFailure(yield* Effect.exit(extension.client.hello(hello("pol_ext_bad"))))
        ).toBe(true);
        yield* Effect.flip(extension.lost).pipe(Effect.timeout("2 seconds"));
      })
    )
  );
});
