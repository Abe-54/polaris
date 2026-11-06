import { expect, test } from "bun:test";
import { join } from "node:path";
import { connectRpc, socketTransport } from "@polaris/client";
import * as P from "@polaris/protocol";
import { Effect, Queue, Schema } from "effect";
import { ServerRpcs } from "./rpcs.ts";
import { startServer } from "./server.ts";
import { scopedTempDir } from "../platform/tempDir.testing.ts";

const temporary = scopedTempDir("pl-lang-", { short: true });

const options = (root: string) => ({
  root,
  socketPath: join(root, "daemon.sock"),
  lockPath: join(root, "daemon.lock"),
});

/** Payload remains unknown so malformed inputs reach the real server codec. */

const RawRequest = Schema.TaggedStruct("Request", {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Unknown,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

test("existing RPC connection returns typed unavailable language defaults without advertising support", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;

        yield* startServer(options(root));

        const transport = yield* socketTransport(join(root, "daemon.sock"));

        const rpc = yield* connectRpc(transport);

        const hello = yield* rpc.client.hello({
          clientName: "fake-language-client",
          clientVersion: "0",
          deviceLabel: "fixture",
          capabilities: [],
        });

        const error = yield* Effect.flip(rpc.client["languages.catalog"]({}));

        return { hello, error };
      })
    )
  );

  expect(result.hello.capabilities).not.toContain("languages");

  expect(result.error).toBeInstanceOf(P.LanguageError);

  expect(result.error.reason).toBe("unsupported-capability");
});

test("raw tree wire rejects malformed decisions before handlers and retains full manifests", async () => {
  const seen: P.LanguageTreeEditDecision[] = [];

  const handlers = ServerRpcs.toLayerHandler("languages.tree.edit.decide", (input) => {
    seen.push(input);

    return Effect.succeed(
      P.LanguageTreeOperationOutcome.make({
        format: 2,
        operationId: input.acceptance.operationId,
        proposalId: input.acceptance.proposalId,
        owner: input.acceptance.fence.context,
        state: "rejected",
        draftsDurable: false,
        receiptDurable: false,
        receiptRevision: 0,
        draftGroupId: null,
        steps: [],
        failedChange: null,
        message: "Codec fixture only",
      })
    );
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;

        const server = yield* startServer({ ...options(root), handlers });

        const context = P.LanguageContextIdentity.make({
          hostId: server.hostInfo.hostId,
          clientId: "fake-client",
          contextId: "context",
          checkout: P.LanguageCheckout.cases.Workspace.make({
            workspaceId: P.WorkspaceId.make("fixture"),
            path: root,
          }),
          projectRoot: root,
          providerId: "fixture",
          configurationFingerprint: "a".repeat(64),
          generation: 1,
        });

        const snapshot = P.LanguageResourceSnapshot.make({
          uri: `file://${root}/a`,
          canonicalPath: `${root}/a`,
          tree: P.LanguageTreeManifest.make({
            format: 1,
            entries: [
              P.LanguageTreeEntry.make({
                relativePath: "",
                kind: "directory",
                identity: P.LanguageResourceIdentity.make({ device: 1, inode: 1, mode: 0o755 }),
                version: null,
              }),
            ],
          }),
        });

        const acceptance = P.LanguageTreeEditAcceptance.make({
          format: 2,
          proposalId: "proposal",
          operationId: "operation",
          fence: P.LanguageRequestFence.make({ context, requiredSequence: 0, documents: [] }),
          snapshots: [],
          resourceSnapshots: [snapshot],
          decision: "reject",
        });

        const responses = yield* Queue.bounded<string>(8);

        const transport = yield* socketTransport(join(root, "daemon.sock"));

        const wire = yield* P.makeWire(transport, (text) =>
          Queue.offer(responses, text).pipe(Effect.asVoid)
        );

        yield* wire.sendJson(
          JSON.stringify(
            RawRequest.make({
              id: "bad",
              tag: "languages.tree.edit.decide",
              payload: { acceptance: { ...acceptance, format: 3 }, drafts: null },
              headers: [],
            })
          )
        );

        const text = yield* Queue.take(responses).pipe(Effect.timeout("3 seconds"));

        const header = Schema.decodeUnknownSync(
          Schema.Struct({ _tag: Schema.Literal("Exit"), requestId: Schema.String })
        )(JSON.parse(text));

        expect(header.requestId).toBe("bad");

        expect(seen).toHaveLength(0);

        yield* wire.sendJson(
          JSON.stringify(
            RawRequest.make({
              id: "valid",
              tag: "languages.tree.edit.decide",
              payload: { acceptance, drafts: null },
              headers: [],
            })
          )
        );

        yield* Queue.take(responses).pipe(Effect.timeout("3 seconds"));

        expect(seen).toEqual([P.LanguageTreeEditDecision.make({ acceptance, drafts: null })]);
      })
    )
  );
});
