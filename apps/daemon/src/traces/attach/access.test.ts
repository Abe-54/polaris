import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import {
  Command,
  CommandId,
  CommandRejected,
  ExtensionDaemonRpcs,
  NotGranted,
  ProfileError,
  RequestId,
  SessionId,
  ApprovalDecision,
} from "@polaris/protocol";
import { Effect, Layer, Redacted } from "effect";
import { shortTemp } from "../../platform/testing.ts";
import { ServerRpcs } from "../../transport/rpcs.ts";
import { startServer } from "../../transport/server.ts";

// The real transport gate must reject both paths before they reach their handlers.
test("P9-6: a paired caller without approve cannot start a user capture or answer an approval", async () => {
  const reached: string[] = [];

  const handlers = Layer.mergeAll(
    ServerRpcs.toLayerHandler("profiles.attach", () =>
      Effect.gen(function* () {
        reached.push("capture");

        return yield* new ProfileError({
          code: "E-PROFILE-NOT-FOUND",
          message: "No target",
          fix: "Select a target",
        });
      })
    ),
    ServerRpcs.toLayerHandler("dispatch", ({ commandId }) =>
      Effect.gen(function* () {
        reached.push("approval");

        return yield* new CommandRejected({ commandId, reason: "No request" });
      })
    )
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(shortTemp("uf14-grant-"))),
          (value) => Effect.sync(() => rmSync(value, { recursive: true, force: true }))
        );

        const server = yield* startServer({
          root,
          socketPath: join(root, "d.sock"),
          lockPath: join(root, "d.lock"),
          handlers,
        });

        const connect = () =>
          Effect.flatMap(socketTransport(server.socketPath), (transport) =>
            connectRpcWith(ExtensionDaemonRpcs, transport)
          );

        const identity = {
          clientName: "test",
          clientVersion: "0",
          deviceLabel: "Test",
          capabilities: [],
        };

        const desktop = yield* connect();
        yield* desktop.client.hello(identity);

        for (const approve of [false, true]) {
          const pairing = yield* desktop.client["extensions.pair"]({
            name: "Profiler",
            grant: approve ? ["read", "approve"] : ["read"],
          });

          const caller = yield* connect();
          yield* caller.client.hello({ ...identity, extensionToken: Redacted.make(pairing.token) });

          const capture = yield* caller.client["profiles.attach"]({
            sessionId: SessionId.make("s1"),
            pid: 42,
            seconds: 1,
          }).pipe(Effect.flip);

          const approval = yield* caller.client
            .dispatch({
              commandId: CommandId.make(crypto.randomUUID()),
              command: Command.cases.RespondToApproval.make({
                sessionId: SessionId.make("s1"),
                requestId: RequestId.make("r1"),
                decision: ApprovalDecision.cases.Allow.make({ remember: false }),
              }),
            })
            .pipe(Effect.flip);

          if (approve) {
            expect(capture).toBeInstanceOf(ProfileError);
            expect(approval).toBeInstanceOf(CommandRejected);
            expect(reached).toEqual(["capture", "approval"]);
          } else {
            expect(capture).toEqual(new NotGranted({ what: "profiles.attach", needed: "approve" }));
            expect(approval).toEqual(
              new NotGranted({ what: "dispatch:RespondToApproval", needed: "approve" })
            );
            expect(reached).toEqual([]);
          }
        }
      })
    )
  );
}, 30000);
