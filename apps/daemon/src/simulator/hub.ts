/**
 * `SimulatorHub`: the Host's Simulators behind the `simulator.*` RPCs and the in-Daemon API
 * the Simulator MCP server calls (ENG-829, ADR 0099). See this folder's README.
 */
import { delimiter, join } from "node:path";
import {
  HubFailed,
  NotFound,
  type SessionId,
  type Simulator,
  SimulatorAttachItem,
  SimulatorNotBootedByPolaris,
  SimulatorNotFound,
  type SimulatorSessionItem,
  SimulatorUnavailable,
  SimulatorWatchItem,
  Unsupported,
} from "@polaris/protocol";
import { type Cause, Effect, Layer, Option, Predicate, Queue, type Scope, Stream } from "effect";
import { type SessionLookup, sessionsFromStore } from "../browser/relaySessions.ts";
import { bunRuntime, SimulatorTools } from "../install/simulator/index.ts";
import { paths } from "../paths.ts";
import { HostPlatform } from "../platform/index.ts";
import { EventStore } from "../store/EventStore.ts";
import { BootedStore } from "./bootedStore.ts";
import { bootDevice, type HubDevice, hubLive, listDevices, shutdownDevice } from "./hubClient.ts";
import { type HubCommand, type HubEndpoint, spawnHub } from "./hubProcess.ts";
import { liveProbe, SimulatorDetection } from "./index.ts";
import { listLocalIos } from "./localDevices.ts";
import { Inventory, WATCH_POLL_MS } from "./inventory.ts";
import { SessionFeeds } from "./sessionFeeds.ts";
import { SimulatorHub } from "./service.ts";
import { simulatorCapable } from "./support.ts";
import type { HubDevices } from "./hubDevices.ts";
import {
  DEFAULT_HUB_TIMING,
  HubSupervisor,
  type HubTiming,
  hubTimingFromEnv,
} from "./supervisor.ts";

export { SimulatorHub } from "./service.ts";

/** A hub that hasn't answered `/healthz` this long after spawning failed to start. */
const HUB_START_TIMEOUT_MS = 60_000;

type SimulatorError = SimulatorNotFound | SimulatorUnavailable | HubFailed | Unsupported;

export interface SimulatorHubConfig {
  /** Holds the hub's private directories and the booted-by-Polaris file. */
  readonly dir: string;
  /** How to run the hub; installs the Simulator's tools on first use. */
  readonly command: Effect.Effect<HubCommand, SimulatorUnavailable>;
  readonly listIos: () => Promise<HubDevices | null>;
  readonly sessions: SessionLookup;
  readonly timing?: HubTiming;
  readonly pollMs?: number;
  readonly startTimeoutMs?: number;
}

/** How `SimulatorHub` is built; `transport/lazySimulator.ts` loads it on first use. */
const layerWith = (config: SimulatorHubConfig) => Layer.effect(SimulatorHub, makeHub(config));

export const SimulatorHubLive = {
  layerWith,

  /** The Daemon's: `~/.polaris/simulator`, the installed tools, the event store's sessions. */
  layer: Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* EventStore;
      const tools = yield* SimulatorTools;
      const runtime = bunRuntime();

      return layerWith({
        dir: join(paths().root, "simulator"),
        command: Effect.map(tools.ensure, (installed) => ({
          argv: [...runtime.argv, installed.hub],
          env: runtime.env,
        })),
        listIos: () => listLocalIos(liveProbe().run),
        sessions: sessionsFromStore(store),
        timing: hubTimingFromEnv(process.env),
      });
    })
  ).pipe(Layer.provideMerge(Layer.merge(SimulatorTools.layer, SimulatorDetection.layer))),

  /** The service's supervisor, for tests that read the hub's pid. */
  testing: {
    supervisorOf: (hub: SimulatorHub["Service"]) => supervisors.get(hub),
  },
};

const supervisors = new WeakMap<object, HubSupervisor>();

const unsupported = () => new Unsupported({ capability: "simulator" });

/** Runs a call to the hub, whose rejections become `HubFailed`. */
const tryHub = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new HubFailed({ detail: error instanceof Error ? error.message : String(error) }),
  });

const withAndroidSdk = (command: HubCommand, sdk: string): HubCommand => ({
  ...command,
  env: {
    ...command.env,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    PATH: [join(sdk, "platform-tools"), join(sdk, "emulator"), process.env.PATH ?? ""].join(
      delimiter
    ),
  },
});

/** `Stream.callback` forks its effect, so a failure there must reach the stream through the queue. */
const callbackStream = <A, E>(
  f: (queue: Queue.Queue<A, E | Cause.Done>) => Effect.Effect<unknown, E, Scope.Scope>
) =>
  Stream.callback<A, E>((queue) =>
    f(queue).pipe(Effect.catch((error) => Queue.fail(queue, error)))
  );

const deviceOf = (simulator: Simulator): HubDevice => ({
  platform: simulator.platform,
  id: simulator.id,
  name: simulator.name,
});

const makeHub = Effect.fnUntraced(function* (config: SimulatorHubConfig) {
  const detection = yield* SimulatorDetection;
  const capable = simulatorCapable(yield* HostPlatform);
  const timing = config.timing ?? DEFAULT_HUB_TIMING;
  const booted = new BootedStore(join(config.dir, "booted.json"));
  const feeds = new SessionFeeds();
  const attached = new Map<string, number>();
  const log = (message: string) => Effect.runFork(Effect.logWarning(message));
  let command: HubCommand | null = null;

  const ready = () =>
    Effect.runPromise(
      Effect.map(detection.current, ({ support }) => ({
        ios: Predicate.isTagged(support.ios, "Ready"),
        android: Predicate.isTagged(support.android, "Ready"),
      }))
    );

  const supervisor: HubSupervisor = new HubSupervisor({
    spawn: async () => {
      // An idle stop with no hub yet may be the first start: install the tools as an attach would.
      if (command === null) await Effect.runPromise(prepare);

      if (command === null) throw new Error("the Simulator's tools aren't installed");

      return spawnHub(
        command,
        join(config.dir, "hub"),
        config.startTimeoutMs ?? HUB_START_TIMEOUT_MS
      );
    },
    probe: (endpoint) =>
      hubLive(
        endpoint,
        [...attached.keys()].filter((id) => inventory.find(id)?.platform === "ios")
      ),
    beforeIdleStop: (endpoint) => shutDownOurs(endpoint),
    ownsBooted: () => booted.all.size > 0,
    log,
    timing,
  });

  const inventory: Inventory = new Inventory({
    ready,
    listIos: config.listIos,
    listHub: () => {
      const endpoint = supervisor.current;

      return endpoint === null ? Promise.resolve(null) : listDevices(endpoint);
    },
    booted,
    pollMs: config.pollMs ?? WATCH_POLL_MS,
    log,
  });

  /** Shuts down only the Simulators Polaris booted; never anyone else's. */
  const shutDownOurs = async (endpoint: HubEndpoint) => {
    // A fresh list, not one in flight: it, or the last, may predate a boot finishing.
    await inventory.refreshFresh();

    for (const id of Array.from(booted.all)) {
      const simulator = inventory.find(id);

      if (simulator !== null && simulator.state !== "Shutdown")
        await shutdownDevice(endpoint, deviceOf(simulator)).catch((error) =>
          log(`shutting down Simulator ${id} failed: ${String(error)}`)
        );
      booted.delete(id);
    }

    await inventory.refresh();
  };

  yield* Effect.addFinalizer(() => Effect.promise(() => supervisor.close()));

  const requireCapable = capable ? Effect.void : Effect.fail(unsupported());

  /** The report, failing with why when no platform is ready (`iosBlocked` names Xcode's state). */
  const requireReady = Effect.flatMap(detection.current, (report) => {
    const { ios, android } = report.support;

    if (Predicate.isTagged(ios, "Ready") || Predicate.isTagged(android, "Ready"))
      return Effect.succeed(report);

    return Effect.fail(
      new SimulatorUnavailable({
        message: report.iosBlocked ?? "No Simulator platform is ready on this Host",
      })
    );
  });

  /** The hub's command, installing the tools on first use; it gets the Android SDK's tools. */
  const prepare = Effect.gen(function* () {
    yield* requireCapable;
    const report = yield* requireReady;

    if (command !== null) return;
    const base = yield* config.command;
    command = report.androidSdk === null ? base : withAndroidSdk(base, report.androidSdk);
  });

  /** `fresh` lists again first, for a decision on the Simulator's state. */
  const find = Effect.fnUntraced(function* (id: string, fresh = false) {
    if (fresh) yield* Effect.promise(() => inventory.refresh());

    const simulator =
      inventory.find(id) ?? (yield* Effect.promise(() => inventory.refresh()), inventory.find(id));

    if (simulator === null) return yield* new SimulatorNotFound({ id });

    return simulator;
  });

  const hubCall = <A>(run: (endpoint: HubEndpoint) => Promise<A>) =>
    tryHub(() => supervisor.using(run));

  const boot = Effect.fnUntraced(function* (id: string) {
    yield* prepare;
    const simulator = yield* find(id, true);

    if (simulator.state === "Booted") return;
    inventory.markBooting(id);
    yield* hubCall((endpoint) => bootDevice(endpoint, deviceOf(simulator))).pipe(
      Effect.tap(() => Effect.sync(() => booted.add(id))),
      Effect.ensuring(
        Effect.promise(() => {
          inventory.settle(id);

          return inventory.refresh();
        })
      )
    );
  });

  const shutdown = Effect.fnUntraced(function* (id: string, force: boolean) {
    yield* requireCapable;
    const simulator = yield* find(id, true);

    // One Polaris just booted may still list as Shutdown: shut it down anyway.
    if (simulator.state === "Shutdown" && !booted.has(id)) return;

    if (!force && !booted.has(id)) return yield* new SimulatorNotBootedByPolaris({ id });
    yield* prepare;

    const failed = yield* hubCall((endpoint) => shutdownDevice(endpoint, deviceOf(simulator))).pipe(
      Effect.flip,
      Effect.option
    );

    yield* Effect.promise(() => inventory.refresh());

    if (Option.isSome(failed) && inventory.find(id)?.state === "Booted") return yield* failed.value;
    booted.delete(id);
  });

  const restart = Effect.gen(function* () {
    yield* prepare;
    yield* tryHub(() => supervisor.restart());
  });

  const requireSession = Effect.fnUntraced(function* (sessionId: SessionId) {
    if ((yield* config.sessions.presence(sessionId)) !== "live")
      return yield* new NotFound({ what: "session", id: sessionId });
  });

  const attach = (sessionId: SessionId, id: string) =>
    callbackStream<SimulatorAttachItem, SimulatorError | NotFound>((queue) =>
      Effect.gen(function* () {
        yield* requireSession(sessionId);
        yield* prepare;
        yield* find(id);
        let last: HubEndpoint | null = null;

        // A start inside `hold` reaches the listener too: send each endpoint once.
        const emit = (endpoint: HubEndpoint) => {
          if (last?.port === endpoint.port && last.token === endpoint.token) return;
          last = endpoint;
          Queue.offerUnsafe(queue, SimulatorAttachItem.cases.Attached.make(endpoint));
        };

        const unsubscribe = supervisor.subscribe(emit);
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

        const held = yield* Effect.acquireRelease(
          tryHub(() => supervisor.hold()),
          (hold) => Effect.sync(hold.release)
        );

        attached.set(id, (attached.get(id) ?? 0) + 1);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            const count = (attached.get(id) ?? 1) - 1;

            if (count === 0) attached.delete(id);
            else attached.set(id, count);
          })
        );
        feeds.show(sessionId, id);
        emit(held.endpoint);
      })
    );

  const watch = callbackStream<SimulatorWatchItem, Unsupported>((queue) =>
    Effect.gen(function* () {
      yield* requireCapable;
      const report = yield* detection.refresh;
      const simulators = yield* Effect.promise(() => inventory.refresh());
      Queue.offerUnsafe(
        queue,
        SimulatorWatchItem.cases.Snapshot.make({ support: report.support, simulators })
      );

      const unsubscribe = inventory.subscribe((change) =>
        Queue.offerUnsafe(
          queue,
          change.kind === "changed"
            ? SimulatorWatchItem.cases.SimulatorChanged.make({ simulator: change.simulator })
            : SimulatorWatchItem.cases.SimulatorRemoved.make({ id: change.id })
        )
      );

      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* detection.changes.pipe(
        Stream.runForEach((support) =>
          Effect.sync(() => {
            Queue.offerUnsafe(queue, SimulatorWatchItem.cases.SupportChanged.make({ support }));
            void inventory.refresh();
          })
        ),
        Effect.forkScoped
      );
    })
  );

  const sessionFeed = (sessionId: SessionId) =>
    callbackStream<SimulatorSessionItem, NotFound | Unsupported>((queue) =>
      Effect.gen(function* () {
        yield* requireCapable;
        yield* requireSession(sessionId);
        const unsubscribe = feeds.subscribe(sessionId, (item) => Queue.offerUnsafe(queue, item));
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      })
    );

  const service = SimulatorHub.of({
    watch,
    boot,
    shutdown,
    restart,
    attach,
    sessionFeed,
    agentOpened: (sessionId, id) =>
      Effect.sync(() => {
        supervisor.touch();
        feeds.agentOpened(sessionId, id);
      }),
    agentDriving: (sessionId) =>
      Effect.asVoid(
        Effect.acquireRelease(
          Effect.sync(() => {
            supervisor.touch();

            return feeds.driving(sessionId);
          }),
          (release) =>
            Effect.sync(() => {
              supervisor.touch();
              release();
            })
        )
      ),
    shown: (sessionId) => Effect.sync(() => feeds.shown(sessionId)),
    agentBooted: (id) =>
      Effect.sync(() => {
        supervisor.touch();
        booted.add(id);
      }),
  });

  supervisors.set(service, supervisor);

  return service;
});
