/**
 * User access over a real socket (ENG-700, ADR 0100): the Desktop App's key is enrolled on
 * first use, and a process with only socket access is refused approvals and secrets, with no
 * key or its own. Extensions keep their Grants; deleting the enrolment file re-enrols.
 */
import { expect, test } from "bun:test";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import {
  ApprovalDecision,
  Command,
  CommandId,
  CommandRejected,
  ExtensionDaemonRpcs,
  RequestId,
  SessionId,
  UserAccessGate,
} from "@polaris/protocol";
import { Cause, Effect, Exit, Layer, Option, Redacted, type Scope } from "effect";
import { ServerRpcs } from "./rpcs.ts";
import { startServer } from "./server.ts";
import { scopedTempDir } from "../platform/tempDir.testing.ts";

const temporary = scopedTempDir("pl-ua-", { short: true });

/** The client group decodes both gates' refusals. */
const Rpcs = ExtensionDaemonRpcs.middleware(UserAccessGate);

const REACHED = "reached the handler";

const handlers = Layer.mergeAll(
  ServerRpcs.toLayerHandler("dispatch", ({ commandId }) =>
    Effect.fail(new CommandRejected({ commandId, reason: REACHED }))
  ),
  ServerRpcs.toLayerHandler("secret.provide", () => Effect.void)
);

const DESKTOP_KEY = "a".repeat(64);

const AGENT_KEY = "b".repeat(64);

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

const rename = command(Command.cases.RenameSession.make({ sessionId, title: "t" }));

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

const connectAt = (socketPath: string) =>
  Effect.flatMap(socketTransport(socketPath), (transport) => connectRpcWith(Rpcs, transport));

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

test("a process with only socket access can't approve or answer a secret once the Desktop App enrolled", async () => {
  const result = await Effect.runPromise(
    withServer((connect) =>
      Effect.gen(function* () {
        const desktop = yield* connect();
        const enrolled = yield* desktop.client.hello(hello(DESKTOP_KEY));

        const agent = yield* connect();
        const preHello = yield* outcome(agent.client.dispatch(approve));
        const keyless = yield* agent.client.hello(hello());

        const ownKey = yield* connect();
        const ownKeyHello = yield* ownKey.client.hello(hello(AGENT_KEY));

        return {
          desktopAccess: enrolled.userAccess,
          desktopApproves: yield* outcome(desktop.client.dispatch(approve)),
          desktopSecret: yield* outcome(desktop.client["secret.provide"](secret)),
          preHello,
          keylessAccess: keyless.userAccess,
          keylessApproves: yield* outcome(agent.client.dispatch(approve)),
          keylessSecret: yield* outcome(agent.client["secret.provide"](secret)),
          keylessPairs: yield* outcome(
            agent.client["extensions.pair"]({ name: "x", grant: ["approve"] })
          ),
          keylessRenames: yield* outcome(agent.client.dispatch(rename)),
          ownKeyAccess: ownKeyHello.userAccess,
          ownKeyApproves: yield* outcome(ownKey.client.dispatch(approve)),
        };
      })
    )
  );

  expect(result).toEqual({
    desktopAccess: true,
    desktopApproves: "reached",
    desktopSecret: "ok",
    preHello: "UserAccessRequired:dispatch:RespondToApproval",
    keylessAccess: false,
    keylessApproves: "UserAccessRequired:dispatch:RespondToApproval",
    keylessSecret: "UserAccessRequired:secret.provide",
    keylessPairs: "UserAccessRequired:extensions.pair",
    keylessRenames: "reached",
    ownKeyAccess: false,
    ownKeyApproves: "UserAccessRequired:dispatch:RespondToApproval",
  });
});

test("the Host keeps only a digest, owner-only, and deleting it lets the next key enrol", async () => {
  const result = await Effect.runPromise(
    withServer((connect, root) =>
      Effect.gen(function* () {
        const file = join(root, "user-access.json");
        yield* (yield* connect()).client.hello(hello(DESKTOP_KEY));
        const text = readFileSync(file, "utf8");
        const mode = statSync(file).mode & 0o777;

        rmSync(file);
        const next = yield* (yield* connect()).client.hello(hello(AGENT_KEY));
        const previous = yield* (yield* connect()).client.hello(hello(DESKTOP_KEY));

        return {
          holdsKey: text.includes(DESKTOP_KEY),
          mode,
          nextAccess: next.userAccess,
          previousAccess: previous.userAccess,
        };
      })
    )
  );

  expect(result).toEqual({ holdsKey: false, mode: 0o600, nextAccess: true, previousAccess: false });
});

test("an Extension with the approve Grant approves without a user key", async () => {
  const result = await Effect.runPromise(
    withServer((connect) =>
      Effect.gen(function* () {
        const desktop = yield* connect();
        yield* desktop.client.hello(hello(DESKTOP_KEY));

        const { token } = yield* desktop.client["extensions.pair"]({
          name: "Raycast",
          grant: ["approve"],
        });

        const extension = yield* connect();
        yield* extension.client.hello({ ...hello(), extensionToken: Redacted.make(token) });

        return yield* outcome(extension.client.dispatch(approve));
      })
    )
  );

  expect(result).toBe("reached");
});
