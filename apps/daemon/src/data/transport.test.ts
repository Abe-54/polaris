/** Every Data RPC goes through the real transport, including write-only password decoding. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  connectRpcWith,
  socketTransport,
  watchDataSources,
  watchDataQueryLog,
} from "@polaris/client";
import { DaemonRpcs, RequestId, SessionId, Unsupported } from "@polaris/protocol";
import { Effect, Layer, Redacted, Stream } from "effect";
import { shortTemp } from "../platform/testing.ts";
import { HostSecrets } from "../secrets/index.ts";
import { startServer } from "../transport/server.ts";
import { DataSources, DataQueries, DataRpcsLive } from "./index.ts";

const sessionId = SessionId.make("data-session");

const label = { text: "Local", colour: "none" } as const;

test("Data capability serves empty watches and typed Unsupported for every request", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = mkdtempSync(shortTemp("pl-data-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(root, { recursive: true, force: true }))
        );

        const server = yield* startServer({
          root,
          socketPath: join(root, "d.sock"),
          lockPath: join(root, "d.lock"),
          handlers: DataRpcsLive.pipe(
            Layer.provide(Layer.merge(DataSources.layer, DataQueries.layer))
          ),
          capabilities: ["data"],
          secrets: HostSecrets.memory(),
        });

        const { client } = yield* connectRpcWith(
          DaemonRpcs,
          yield* socketTransport(server.socketPath)
        );

        const { capabilities } = yield* client.hello({
          clientName: "data-test",
          clientVersion: "0",
          deviceLabel: "test",
          capabilities: [],
        });

        expect(capabilities).toContain("data");
        expect(
          yield* Stream.runCollect(watchDataSources({ client, capabilities }, { sessionId }))
        ).toEqual([[]]);
        expect(
          yield* Stream.runCollect(watchDataQueryLog({ client, capabilities }, { sessionId }))
        ).toEqual([[]]);
        const source = { sessionId, source: "app" };

        const requests = [
          client["data.describe"](source),
          client["data.query"]({ ...source, sql: "select 1", params: [], limit: 1 }),
          client["data.source.save"]({
            sessionId,
            name: "manual",
            engine: "postgres",
            host: "localhost",
            port: 5432,
            database: "app",
            user: "user",
            password: Redacted.make("private"),
            label,
          }),
          client["data.source.remove"](source),
          client["data.source.label"]({ ...source, label }),
          client["data.approval.decide"]({
            approvalId: RequestId.make("approval"),
            decision: "deny",
            scope: "target",
          }),
        ];

        for (const request of requests) {
          expect(yield* Effect.flip(request)).toEqual(new Unsupported({ capability: "data" }));
        }
      })
    )
  ));
