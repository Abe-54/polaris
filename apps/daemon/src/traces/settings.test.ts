import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
  TraceSettingsError,
  WorkspaceId,
  DomainEvent,
  TracesSettingsRpcs,
} from "@polaris/protocol";
import { RpcTest } from "effect/rpc";
import { EventStore } from "../store/EventStore.ts";
import { seed, commit } from "./authority.testing.ts";
import { TEST_WORKSPACE } from "./testing.ts";
import { TracesSettingsRpcsLive } from "./rpcs.ts";
import { TraceSettings } from "./settings.ts";

const id = WorkspaceId.make("settings-test");

const fixture = async (
  run: (root: string, layer: ReturnType<typeof TraceSettings.layerAt>) => Promise<void>
) => {
  const root = newTempDir("p1-settings-", { short: true });

  const resolve = (key: WorkspaceId) =>
    key === id
      ? Effect.succeed(root)
      : Effect.fail(
          new TraceSettingsError({
            code: "E-TRACE-SETTINGS-UNAVAILABLE",
            message: "Unknown Workspace",
            fix: "Select a Workspace",
          })
        );

  try {
    await run(root, TraceSettings.layerAt(join(root, "settings.json"), resolve));
  } finally {
    await removeTempDirSettled(root);
  }
};

test("settings patches persist independently and never persist collector headers", () =>
  fixture(async (root, layer) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* TraceSettings;
        yield* settings.prepare(
          { workspaceId: id, checkout: root, sessionId: null },
          {
            OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test",
            OTEL_EXPORTER_OTLP_HEADERS: "authorization=private-value",
          }
        );
        yield* settings.patch(id, { forwarding: false, autoInstrument: "node" });
        const next = yield* settings.patch(id, { enabled: false });
        expect(next).toMatchObject({
          enabled: false,
          forwarding: false,
          autoInstrument: "node",
          forwardTo: { url: "https://collector.test/v1/traces", headerNames: ["authorization"] },
        });
      }).pipe(Effect.provide(layer))
    );
    expect(await readFile(join(root, "settings.json"), "utf8")).not.toContain("private-value");
    await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* TraceSettings;
        expect(yield* settings.get(id)).toMatchObject({
          enabled: false,
          forwarding: false,
          autoInstrument: "node",
        });
      }).pipe(Effect.provide(layer))
    );
  }));

test("settings validate Workspace authority and resolution follows launch environment then saved setting", () =>
  fixture(async (root, layer) => {
    await writeFile(join(root, ".env"), "OTEL_EXPORTER_OTLP_ENDPOINT=https://file.test");
    await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* TraceSettings;
        yield* settings.patch(id, {
          forwardTo: { url: "https://setting.test/v1/traces", headerNames: [] },
        });
        const context = { workspaceId: id, checkout: root, sessionId: null };
        expect(
          (yield* settings.prepare(context, { OTEL_EXPORTER_OTLP_ENDPOINT: "https://env.test" }))
            .collector?.traces
        ).toBe("https://env.test/v1/traces");
        expect((yield* settings.prepare(context, {})).collector?.traces).toBe(
          "https://setting.test/v1/traces"
        );
        yield* Effect.promise(() => rm(join(root, ".env")));
        expect((yield* settings.prepare(context, {})).collector?.traces).toBe(
          "https://setting.test/v1/traces"
        );
        yield* settings.patch(id, { forwardTo: null });
        expect((yield* settings.policy(context)).collector).toBeNull();

        const result = yield* Effect.result(
          settings.patch(WorkspaceId.make("unknown"), { forwarding: true })
        );

        expect(result).toHaveProperty("failure.code", "E-TRACE-SETTINGS-UNAVAILABLE");
      }).pipe(Effect.provide(layer))
    );
  }));

for (const [override, expected] of [
  [undefined, "https://upstream.test/v1/traces"],
  ["https://child.test/v1/traces", "https://child.test/v1/traces"],
] as const)
  test(`child environment ${override === undefined ? "inherits the upstream target" : "honors a newly exported target"}`, () =>
    fixture(async (root, layer) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const settings = yield* TraceSettings;
          const context = { workspaceId: id, checkout: root, sessionId: null };
          yield* settings.prepare(context, {
            OTEL_EXPORTER_OTLP_ENDPOINT: "https://upstream.test",
          });

          const next = yield* settings.prepare(context, {
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:4319/otlp/${"a".repeat(64)}`,
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: override,
          });

          expect(next.collector?.traces).toBe(expected);
        }).pipe(Effect.provide(layer))
      );
    }));

test("production settings RPC resolves registered workspace authority and rejects removal", () =>
  fixture(async (root) => {
    const layer = TracesSettingsRpcsLive.pipe(
      Layer.provide(TraceSettings.layerFromStoreAt(join(root, "authority-settings.json"))),
      Layer.provideMerge(EventStore.layerSqlite(join(root, "events.sqlite")))
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rpc = yield* RpcTest.makeClient(TracesSettingsRpcs);
          expect(
            yield* Effect.result(rpc["traces.settings"]({ workspaceId: TEST_WORKSPACE }))
          ).toHaveProperty("failure.code", "E-TRACE-SETTINGS-UNAVAILABLE");
          yield* seed(root);
          expect(
            yield* rpc["traces.setSettings"]({
              workspaceId: TEST_WORKSPACE,
              settings: { forwarding: false },
            })
          ).toMatchObject({ forwarding: false, enabled: true });
          yield* commit([DomainEvent.cases.WorkspaceRemoved.make({ workspaceId: TEST_WORKSPACE })]);
          expect(
            yield* Effect.result(
              rpc["traces.setSettings"]({
                workspaceId: TEST_WORKSPACE,
                settings: { forwarding: true },
              })
            )
          ).toHaveProperty("failure.code", "E-TRACE-SETTINGS-UNAVAILABLE");
        })
      ).pipe(Effect.provide(layer))
    );
  }));

test("a workspace cannot forward back into a Polaris token endpoint", () =>
  fixture(async (_root, layer) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* TraceSettings;

        const result = yield* Effect.result(
          settings.patch(id, {
            forwardTo: {
              url: `http://127.0.0.1:4319/otlp/${"a".repeat(64)}/v1/traces`,
              headerNames: [],
            },
          })
        );

        expect(result).toHaveProperty("failure.code", "E-TRACE-SETTINGS-INVALID");
        expect((yield* settings.get(id)).forwardTo).toBeNull();
      }).pipe(Effect.provide(layer))
    );
  }));
