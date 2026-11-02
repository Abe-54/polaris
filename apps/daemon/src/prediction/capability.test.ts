import { expect, test } from "bun:test";
import { join } from "node:path";
import { connectRpc, socketTransport } from "@polaris/client";
import { Effect } from "effect";
import { PredictionCapabilityLive } from "./capability.ts";
import { startServer } from "../transport/server.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

test("Capability RPC discovers configured endpoints, isolates bad responses and negotiates support", async () => {
  let calls = 0;

  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      calls++;

      return new URL(request.url).pathname === "/v1/models"
        ? Response.json({ data: [{ id: "tplace-custom-model" }] })
        : Response.json({ error: "not ollama" }, { status: 404 });
    },
  });

  const root = newTempDir("pl-predict-cap-", { short: true });

  try {
    const results = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startServer({
            root,
            socketPath: join(root, "daemon.sock"),
            lockPath: join(root, "daemon.lock"),
            handlers: PredictionCapabilityLive,
            capabilities: ["prediction.capability"],
          });
          const transport = yield* socketTransport(join(root, "daemon.sock"));
          const rpc = yield* connectRpc(transport);

          const hello = yield* rpc.client.hello({
            clientName: "tplace",
            clientVersion: "0",
            deviceLabel: "fixture",
            capabilities: [],
          });

          const input = { endpoints: [`http://127.0.0.1:${endpoint.port}`] };
          const first = yield* rpc.client["prediction.capability"](input);
          const second = yield* rpc.client["prediction.capability"](input);

          return { hello, first, second };
        })
      )
    );

    expect(results.hello.capabilities).toContain("prediction.capability");
    expect(
      results.first.endpoints.find((entry) => entry.models.includes("tplace-custom-model"))?.kind
    ).toBe("openai");
    expect(results.first.machine.ramBytes).toBeGreaterThan(0);
    expect(results.first).toEqual(results.second);
    expect(calls).toBe(2);
  } finally {
    await endpoint.stop(true);
    removeTempDir(root);
  }
});
