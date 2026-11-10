/**
 * Computer use on this Host (ENG-846): its status, on or off, the always-allowed apps and the
 * Controlled apps, and the Host feed. Nothing polls: the Host is checked when asked.
 */
import { join } from "node:path";
import {
  AllowedApp,
  type AppId,
  type ComputerUsePermission,
  type ComputerUseSetup,
  ComputerUseSetupFailed,
  ComputerUseState,
  ComputerUseStatus,
  type ControlledApp,
  type DesktopApp,
} from "@polaris/protocol";
import {
  Context,
  Effect,
  FiberHandle,
  Layer,
  Match,
  Option,
  Predicate,
  Schedule,
  Semaphore,
  Stream,
} from "effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { paths } from "../paths.ts";
import { ComputerUseHelper } from "../service/computerUse/index.ts";
import { type Desktop, detectDesktop } from "./desktop.ts";
import { feedOf, type HostFeed } from "./feed.ts";
import { linuxSetup } from "./linux.ts";
import { macSetup, openSetupCommands } from "./mac.ts";
import { type HostProbe, hostProbe } from "./probe.ts";
import { computerUseFile, type StoredComputerUse } from "./storage.ts";

export interface HostState {
  readonly stored: StoredComputerUse;
  /** Null until the Host is first checked. */
  readonly status: ComputerUseStatus | null;
  readonly desktop: Desktop | null;
  readonly controlled: ReadonlyArray<ControlledApp>;
}

/** The first of NoDesktop, Off, NeedsSetup and Ready that applies (`computer-use.md`). */
export const stateOf = (
  desktop: Desktop | null,
  enabled: boolean,
  setup: ComputerUseSetup | null
): ComputerUseState => {
  if (desktop === null) return ComputerUseState.cases.NoDesktop.make({});

  if (!enabled) return ComputerUseState.cases.Off.make({});

  return setup === null
    ? ComputerUseState.cases.Ready.make({})
    : ComputerUseState.cases.NeedsSetup.make({ setup });
};

const byName = (apps: ReadonlyArray<AllowedApp>) =>
  apps.toSorted((a, b) => a.app.name.localeCompare(b.app.name) || a.app.id.localeCompare(b.app.id));

const setupFailed = (message: string) => new ComputerUseSetupFailed({ message });

export class ComputerUseHost extends Context.Service<
  ComputerUseHost,
  {
    /** The last check; the first use checks the Host. */
    readonly current: Effect.Effect<ComputerUseStatus>;
    /** Checks the Host again: for `refresh`, and when a session needs computer use. */
    readonly ensure: Effect.Effect<ComputerUseStatus>;
    readonly changes: Stream.Stream<ComputerUseStatus>;
    /** Linux: what agent-desktop needs in its environment to reach the desktop; else empty. */
    readonly desktopEnv: Effect.Effect<Readonly<Record<string, string>>>;
    readonly enable: Effect.Effect<ComputerUseStatus>;
    /** Turns it off and releases every Controlled app. */
    readonly disable: Effect.Effect<ComputerUseStatus>;
    readonly openSetup: (
      permission: ComputerUsePermission | null
    ) => Effect.Effect<ComputerUseStatus, ComputerUseSetupFailed>;
    readonly allowedApps: Effect.Effect<ReadonlyArray<AllowedApp>>;
    /** "Always allow on this Host"; an app already on the list keeps its first `allowedAt`. */
    readonly allowApp: (app: DesktopApp) => Effect.Effect<ReadonlyArray<AllowedApp>>;
    readonly removeAllowedApp: (appId: AppId) => Effect.Effect<ReadonlyArray<AllowedApp>>;
    /** Replaces the Controlled apps the Host feed shows. */
    readonly setControlledApps: (apps: ReadonlyArray<ControlledApp>) => Effect.Effect<void>;
    readonly feed: HostFeed;
  }
>()("polaris/daemon/computerUse/ComputerUseHost") {
  /** On the Host's probe, with its state in `file`; `follow` paces rechecks after `openSetup`. */
  static readonly layerWith = (options: HostOptions) =>
    Layer.effect(ComputerUseHost, make(options));

  static readonly layer = Layer.unwrap(
    Effect.sync(() =>
      ComputerUseHost.layerWith({
        probe: hostProbe(),
        file: join(paths().root, "computer-use.json"),
      })
    )
  );
}

export interface HostOptions {
  readonly probe: HostProbe;
  readonly file: string;
  /** How often, and how many times, the Host is checked after setup opens; 2 s for 3 min. */
  readonly follow?: { readonly every: number; readonly times: number };
  readonly now?: () => Date;
}

const FOLLOW = { every: 2000, times: 90 };

const make = Effect.fnUntraced(function* (options: HostOptions) {
  const { probe } = options;
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  const helper = yield* Effect.serviceOption(ComputerUseHelper);
  const file = computerUseFile(options.file);

  const ref = yield* SubscriptionRef.make<HostState>({
    stored: yield* file.read,
    status: null,
    desktop: null,
    controlled: [],
  });

  const checks = yield* Semaphore.make(1);
  const writes = yield* Semaphore.make(1);
  const following = yield* FiberHandle.make<void, never>();

  const permissions = Option.match(helper, {
    onNone: () => Effect.succeed(null),
    onSome: (service) =>
      service.permissions.pipe(
        Effect.tapError((error) => Effect.logWarning("computer use helper", error.message)),
        Effect.orElseSucceed(() => null)
      ),
  });

  const setupOf = (desktop: Desktop) =>
    Match.value(desktop).pipe(
      Match.when({ platform: "macos" }, () => Effect.map(permissions, macSetup)),
      Match.when({ platform: "linux" }, (linux) => Effect.promise(() => linuxSetup(probe, linux))),
      Match.orElse(() => Effect.succeed(null))
    );

  /** Checks the Host and publishes what it found; one check at a time. */
  const check = checks.withPermit(
    Effect.gen(function* () {
      const enabled = (yield* SubscriptionRef.get(ref)).stored.enabled;
      const desktop = yield* Effect.promise(() => detectDesktop(probe));
      const setup = desktop !== null && enabled ? yield* setupOf(desktop) : null;

      const status = ComputerUseStatus.make({
        state: stateOf(desktop, enabled, setup),
        checkedAt: now(),
      });

      yield* SubscriptionRef.update(ref, (state) => ({ ...state, status, desktop }));

      return status;
    })
  );

  const current = Effect.flatMap(SubscriptionRef.get(ref), (state) =>
    state.status === null ? check : Effect.succeed(state.status)
  );

  const save = (next: (stored: StoredComputerUse) => StoredComputerUse) =>
    writes.withPermit(
      Effect.gen(function* () {
        const stored = next((yield* SubscriptionRef.get(ref)).stored);
        yield* Effect.orDie(file.write(stored));
        yield* SubscriptionRef.update(ref, (state) => ({ ...state, stored }));

        return stored;
      })
    );

  /** After setup opens, rechecks until the user has granted it or the window passes. */
  const follow = (schedule: { readonly every: number; readonly times: number }) =>
    check.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(schedule.every),
        times: schedule.times,
        while: (status) => Predicate.isTagged(status.state, "NeedsSetup"),
      }),
      Effect.asVoid
    );

  const openOnMac = (permission: ComputerUsePermission | null) =>
    Effect.gen(function* () {
      const service = yield* Option.match(helper, {
        onNone: () => Effect.fail(setupFailed("This Daemon has no computer use helper beside it")),
        onSome: Effect.succeed,
      });

      const bundle = yield* Effect.mapError(service.bundle, (error) => setupFailed(error.message));

      for (const argv of openSetupCommands(permission, bundle)) {
        const ran = yield* Effect.promise(() => probe.run(argv));

        if (ran.code !== 0) return yield* setupFailed("System Settings could not be opened");
      }

      const status = yield* check;
      yield* FiberHandle.run(following)(follow(options.follow ?? FOLLOW));

      return status;
    });

  const openSetup = (permission: ComputerUsePermission | null) =>
    probe.platform === "darwin"
      ? openOnMac(permission)
      : Effect.flatMap(current, (status) => Effect.fail(setupFailed(nothingToOpen(status))));

  const allowedApps = Effect.map(SubscriptionRef.get(ref), (state) => byName(state.stored.allowed));

  const allowApp = (app: DesktopApp) =>
    Effect.map(
      save((stored) => ({
        ...stored,
        allowed: stored.allowed.some((allowed) => allowed.app.id === app.id)
          ? stored.allowed
          : [...stored.allowed, AllowedApp.make({ app, allowedAt: now() })],
      })),
      (stored) => byName(stored.allowed)
    );

  const removeAllowedApp = (appId: AppId) =>
    Effect.map(
      save((stored) => ({
        ...stored,
        allowed: stored.allowed.filter((allowed) => allowed.app.id !== appId),
      })),
      (stored) => byName(stored.allowed)
    );

  const disable = Effect.gen(function* () {
    yield* FiberHandle.clear(following);
    yield* save((stored) => ({ ...stored, enabled: false }));
    yield* SubscriptionRef.update(ref, (state) => ({ ...state, controlled: [] }));

    return yield* check;
  });

  const changes = SubscriptionRef.changes(ref).pipe(
    Stream.map((state) => state.status),
    Stream.filter((status): status is ComputerUseStatus => status !== null),
    Stream.changesWith((a, b) => a === b)
  );

  return ComputerUseHost.of({
    current,
    ensure: check,
    changes,
    desktopEnv: Effect.flatMap(current, () =>
      Effect.map(SubscriptionRef.get(ref), (state) =>
        state.desktop?.platform === "linux" ? state.desktop.env : {}
      )
    ),
    enable: Effect.andThen(
      save((stored) => ({ ...stored, enabled: true })),
      check
    ),
    disable,
    openSetup,
    allowedApps,
    allowApp,
    removeAllowedApp,
    setControlledApps: (apps) =>
      SubscriptionRef.update(ref, (state) => ({ ...state, controlled: apps })),
    feed: feedOf(ref, current),
  });
});

/** Why `openSetup` has nothing to open off macOS: the Host's next step in words. */
export const nothingToOpen = (status: ComputerUseStatus): string =>
  Match.value(status.state).pipe(
    Match.tag("NeedsSetup", ({ setup }) =>
      Match.value(setup).pipe(
        Match.tag("LinuxPackages", ({ packages, command }) =>
          command === null
            ? `Install ${packages.join(", ")} on this Host, then check again.`
            : `Run \`${command}\` on this Host, then check again.`
        ),
        Match.tag(
          "AccessibilityBus",
          () => "Turn on the accessibility bus (AT-SPI) on this Host's desktop, then check again."
        ),
        Match.tag("MacPermissions", () => "Setup opens only on the Mac itself."),
        Match.exhaustive
      )
    ),
    Match.orElse(() => "There is nothing to set up on this Host.")
  );
