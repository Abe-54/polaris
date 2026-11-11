/**
 * User access over a real socket with the user gate off (ENG-926, ADR 0110): any number of
 * Desktop Apps, each with its own user key, approve on one Host, and nothing is enrolled.
 */
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectRpc, socketTransport } from "@polaris/client";
import {
  ApprovalDecision,
  Command,
  CommandId,
  CommandRejected,
  RequestId,
  SessionId,
} from "@polaris/protocol";
import { Cause, Effect, Exit, Layer, Option, Redacted, type Scope } from "effect";
import { ServerRpcs } from "./rpcs.ts";
import { startServer } from "./server.ts";
import { scopedTempDir } from "../platform/tempDir.testing.ts";

const temporary = scopedTempDir("pl-ua-", { short: true });

const REACHED = "reached the handler";

const handlers = Layer.mergeAll(
  ServerRpcs.toLayerHandler("dispatch", ({ commandId }) =>
    Effect.fail(new CommandRejected({ commandId, reason: REACHED }))
  ),
  ServerRpcs.toLayerHandler("secret.provide", () => Effect.void)
);

const DESKTOP_KEY = "a".repeat(64);

const LAPTOP_KEY = "b".repeat(64);

const identity = {
  clientName: "test",
  clientVersion: "0",
  deviceLabel: "Test MacBook",
  capabilities: [],
};

const hello = (userKey?: string) =>
  userKey === undefined ? identity : { ...identity, userKey: Redacted.make(userKey) };

const sessionId = SessionId.make("s1");

const requestId = RequestId.make("r1");

const command = (value: Command) => ({
  commandId: CommandId.make(crypto.randomUUID()),
  command: value,
});

const approve = command(
  Command.cases.RespondToApproval.make({
    sessionId,
    requestId,
    decision: ApprovalDecision.cases.Allow.make({ remember: false }),
  })
);

const secret = { sessionId, requestId, value: Redacted.make("hunter2") };

/** The refusal's tag and what it named, or whether the request reached its handler. */
const outcome = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    if (Exit.isSuccess(exit)) return "ok";
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));

    if (error === undefined) return "defect";

    if (error instanceof CommandRejected && error.reason === REACHED) return "reached";

    return "what" in error ? `${error._tag}:${String(error.what)}` : error._tag;
  });

/** The Desktop App's group, as it connects over the socket. */
const connectAt = (socketPath: string) => Effect.flatMap(socketTransport(socketPath), connectRpc);

type Connect = () => ReturnType<typeof connectAt>;

/** A server with this module's handlers in a throwaway root, and how to connect to it. */
const withServer = <A, E>(
  body: (connect: Connect, root: string) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporary;

      const server = yield* startServer({
        root,
        socketPath: join(root, "d.sock"),
        lockPath: join(root, "d.lock"),
        handlers,
      });

      return yield* body(() => connectAt(server.socketPath), root);
    })
  );

const run = (shellCommand: string) =>
  command(Command.cases.RunShellCommand.make({ sessionId, command: shellCommand }));

test("a second Desktop App approves, answers a secret and runs a command on a Host another one uses", async () => {
  const result = await Effect.runPromise(
    withServer((connect, root) =>
      Effect.gen(function* () {
        const studio = yield* connect();
        const studioHello = yield* studio.client.hello(hello(DESKTOP_KEY));

        const laptop = yield* connect();
        const laptopHello = yield* laptop.client.hello(hello(LAPTOP_KEY));

        return {
          access: [studioHello.userAccess, laptopHello.userAccess],
          studioApproves: yield* outcome(studio.client.dispatch(approve)),
          laptopApproves: yield* outcome(laptop.client.dispatch(approve)),
          laptopSecret: yield* outcome(laptop.client["secret.provide"](secret)),
          laptopRuns: yield* outcome(laptop.client.dispatch(run("ls"))),
          enrolled: existsSync(join(root, "user-access.json")),
        };
      })
    )
  );

  expect(result).toEqual({
    access: [true, true],
    studioApproves: "reached",
    laptopApproves: "reached",
    laptopSecret: "ok",
    laptopRuns: "reached",
    enrolled: false,
  });
});

test("a Host that enrolled another Desktop App under 0.9.x no longer refuses this one", async () => {
  const result = await Effect.runPromise(
    withServer((connect, root) =>
      Effect.gen(function* () {
        writeFileSync(
          join(root, "user-access.json"),
          JSON.stringify({
            version: 1,
            keys: [{ digest: "0".repeat(64), label: "MacBook Pro", enrolledAt: "2026-11-10" }],
          })
        );

        const desktop = yield* connect();
        const welcome = yield* desktop.client.hello(hello(DESKTOP_KEY));

        const keyless = yield* connect();
        yield* keyless.client.hello(hello());

        return {
          access: welcome.userAccess,
          approves: yield* outcome(desktop.client.dispatch(approve)),
          keylessApproves: yield* outcome(keyless.client.dispatch(approve)),
        };
      })
    )
  );

  expect(result).toEqual({ access: true, approves: "reached", keylessApproves: "reached" });
});
