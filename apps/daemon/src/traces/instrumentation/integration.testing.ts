import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { WorkspaceTrust } from "../../services.ts";
import { EventStore } from "../../store/EventStore.ts";
import { TraceRuntime } from "../runtime.ts";
import { TraceSettings } from "../settings.ts";
import { TraceSessions } from "../sessions.ts";
import { TraceStore } from "../store.ts";
import { traceReceiver } from "../receiver.ts";
import { seed } from "../authority.testing.ts";
import { InspectorTargets, type TargetRegistry } from "../attach/registry.ts";

export const withInstrumentation = async <A>(
  run: (fixture: InstrumentationFixture) => Promise<A>,
  targets?: TargetRegistry
) => {
  const root = newTempDir("p3-runtime-", { short: true });
  const checkout = join(root, "app");
  const home = join(root, "home");
  await mkdir(join(checkout, "package"), { recursive: true });
  await mkdir(home);
  let trusted = true;
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);

  const events = EventStore.layerSqlite(join(home, "events.sqlite"));
  const sessions = TraceSessions.layer.pipe(Layer.provideMerge(events));

  const settings = TraceSettings.layerFromStoreAt(join(home, "settings.json")).pipe(
    Layer.provideMerge(sessions),
    Layer.provideMerge(TraceStore.layerAt(join(home, "traces.sqlite"))),
    Layer.provideMerge(events)
  );

  const traces = TraceRuntime.layerAt(join(home, "tokens.json"), port).pipe(
    Layer.provide(targets === undefined ? Layer.empty : Layer.succeed(InspectorTargets, targets)),
    Layer.provideMerge(settings),
    Layer.provideMerge(sessions),
    Layer.provideMerge(
      Layer.succeed(WorkspaceTrust)({ trusted: () => Effect.sync(() => trusted) })
    ),
    Layer.provideMerge(events)
  );

  const runtime = ManagedRuntime.make(
    Layer.effectDiscard(traceReceiver({ port })).pipe(Layer.provideMerge(traces))
  );

  try {
    await runtime.runPromise(seed(checkout));

    return await run({
      checkout,
      home,
      runtime,
      trust: (value) => {
        trusted = value;
      },
    });
  } finally {
    await runtime.dispose();
    await removeTempDirSettled(root);
  }
};

export interface InstrumentationFixture {
  readonly checkout: string;
  readonly home: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<
    TraceRuntime | TraceSettings | TraceSessions | TraceStore | EventStore | WorkspaceTrust,
    never
  >;
  readonly trust: (value: boolean) => void;
}
