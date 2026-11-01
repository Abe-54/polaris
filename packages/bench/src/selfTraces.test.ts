import { expect, test } from "bun:test";
import { Effect } from "effect";
import { awaitReady, cleanup, connect, type DeveloperModeSetting, launchDaemon } from "./daemon.ts";
import { SELF_SPANS_PER_BATCH, selfTraceBatch } from "./selfTraces.ts";

const ingestOnce = async (developerMode: DeveloperModeSetting) => {
  const daemon = await launchDaemon({ binary: null, developerMode });

  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* awaitReady(daemon);
          const client = yield* connect(daemon, "socket", "self-traces");

          // The accepted count, or why the Daemon refused the batch.
          return yield* client.connection.client["traces.ingestSelf"]({
            service: "polaris-desktop-renderer",
            spans: selfTraceBatch(),
          }).pipe(
            Effect.map(({ accepted }) => accepted),
            Effect.catchTag("SelfTraceRejected", (rejected) => Effect.succeed(rejected.reason))
          );
        })
      )
    );
  } finally {
    await daemon.stop();
    cleanup(daemon.home);
  }
};

test("--developer-mode on: the Daemon stores the bench's Self-Trace batch whole", async () => {
  expect(await ingestOnce("on")).toBe(SELF_SPANS_PER_BATCH);
}, 60_000);

test("off by default: the Daemon refuses Client Self-Traces", async () => {
  expect(await ingestOnce("off")).toBe("developer-mode-off");
}, 60_000);
