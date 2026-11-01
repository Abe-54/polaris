/**
 * Developer Mode on this Host (ENG-709): the stored setting and Polaris Workspace override in
 * `developer-mode.json`, leases held in memory, and the Polaris Workspace found by remote.
 */
import { join } from "node:path";
import {
  DeveloperMode,
  DeveloperModeError,
  type Workspace,
  type WorkspaceId,
} from "@polaris/protocol";
import { Context, Effect, Layer, Match, Predicate, type Scope, Semaphore, Stream } from "effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { paths } from "../paths.ts";
import { isEmbeddedPath } from "../platform/detect.ts";
import { EventStore } from "../store/EventStore.ts";
import type { LiveItem } from "../store/hub.ts";
import { detectPolarisWorkspace, isPolarisCheckout } from "./detect.ts";
import { DeveloperModeState } from "./service.ts";
import { developerModeFile, type StoredDeveloperMode } from "./storage.ts";

interface Internal extends StoredDeveloperMode {
  readonly leases: number;
  readonly detected: WorkspaceId | null;
  readonly known: ReadonlySet<WorkspaceId>;
}

const modeOf = (state: Internal, fromSource: boolean): DeveloperMode => {
  const override =
    state.workspaceId !== null && state.known.has(state.workspaceId) ? state.workspaceId : null;

  const polarisWorkspaceId = override ?? state.detected;

  return DeveloperMode.make({
    stored: state.stored,
    leases: state.leases,
    fromSource,
    effective: state.stored || state.leases > 0 || fromSource,
    polarisWorkspaceId,
    polarisWorkspaceSource:
      polarisWorkspaceId === null ? null : override === null ? "remote" : "override",
  });
};

const sameMode = (a: DeveloperMode, b: DeveloperMode) =>
  a.stored === b.stored &&
  a.leases === b.leases &&
  a.effective === b.effective &&
  a.polarisWorkspaceId === b.polarisWorkspaceId &&
  a.polarisWorkspaceSource === b.polarisWorkspaceSource;

const WORKSPACE_EVENTS = ["WorkspaceRegistered", "WorkspaceUpdated", "WorkspaceRemoved"] as const;

const isWorkspaceEvent = (item: LiveItem) =>
  Predicate.isTagged(item, "Event") &&
  WORKSPACE_EVENTS.some((tag) => Predicate.isTagged(item.envelope.event, tag));

const unknownWorkspace = (workspaceId: WorkspaceId) =>
  new DeveloperModeError({
    reason: "unknown-workspace",
    message: `This Host has no Workspace ${workspaceId}`,
  });

/** The writes and the lease the `developerMode.*` handlers need, beside `DeveloperModeState`. */
export class DeveloperModeControl extends Context.Service<
  DeveloperModeControl,
  {
    readonly current: Effect.Effect<DeveloperMode>;
    readonly changes: Stream.Stream<DeveloperMode>;
    readonly setStored: (enabled: boolean) => Effect.Effect<DeveloperMode, DeveloperModeError>;
    readonly setWorkspace: (
      workspaceId: WorkspaceId | null
    ) => Effect.Effect<DeveloperMode, DeveloperModeError>;
    /** Counts a lease until the scope closes. */
    readonly lease: Effect.Effect<void, never, Scope.Scope>;
  }
>()("polaris/developerMode/DeveloperModeControl") {}

export interface DeveloperModeOptions {
  readonly file: string;
  /** The Daemon runs from source, so Developer Mode is always on. */
  readonly fromSource: boolean;
  readonly isPolaris?: (path: string) => Promise<boolean>;
}

const build = Effect.fnUntraced(function* (options: DeveloperModeOptions) {
  const store = yield* EventStore;
  const file = developerModeFile(options.file);
  const saved = yield* file.read;

  const ref = yield* SubscriptionRef.make<Internal>({
    ...saved,
    leases: 0,
    detected: null,
    known: new Set(),
  });

  const writes = yield* Semaphore.make(1);
  const mode = (state: Internal) => modeOf(state, options.fromSource);
  const current = Effect.map(SubscriptionRef.get(ref), mode);
  const changes = SubscriptionRef.changes(ref).pipe(Stream.map(mode), Stream.changesWith(sameMode));

  const refresh = Effect.gen(function* () {
    const workspaces: ReadonlyArray<Workspace> = [...(yield* store.model).workspaces.values()];

    const detected = yield* Effect.promise(() =>
      detectPolarisWorkspace(workspaces, options.isPolaris ?? isPolarisCheckout)
    );

    yield* SubscriptionRef.update(ref, (state) => ({
      ...state,
      detected,
      known: new Set(workspaces.map((workspace) => workspace.id)),
    }));
  });

  // Subscribed before the first read, so a Workspace registered meanwhile is not missed.
  const events = yield* store.subscribe({ filter: isWorkspaceEvent });
  yield* Stream.concat(Stream.succeed(undefined), events).pipe(
    Stream.runForEach(() => refresh),
    Effect.forkScoped
  );

  const save = (next: (state: Internal) => Internal) =>
    writes.withPermit(
      Effect.gen(function* () {
        const state = next(yield* SubscriptionRef.get(ref));
        yield* file.write({ stored: state.stored, workspaceId: state.workspaceId });
        yield* SubscriptionRef.set(ref, state);

        return mode(state);
      })
    );

  const setWorkspace = (workspaceId: WorkspaceId | null) =>
    Effect.gen(function* () {
      if (workspaceId !== null && !(yield* store.model).workspaces.has(workspaceId))
        return yield* unknownWorkspace(workspaceId);

      return yield* save((state) => ({
        ...state,
        workspaceId,
        known: workspaceId === null ? state.known : new Set([...state.known, workspaceId]),
      }));
    });

  const lease = Effect.acquireRelease(
    SubscriptionRef.update(ref, (state) => ({ ...state, leases: state.leases + 1 })),
    () => SubscriptionRef.update(ref, (state) => ({ ...state, leases: state.leases - 1 }))
  ).pipe(Effect.asVoid);

  return {
    state: DeveloperModeState.of({ current, changes }),
    control: DeveloperModeControl.of({
      current,
      changes,
      setStored: (enabled) => save((state) => ({ ...state, stored: enabled })),
      setWorkspace,
      lease,
    }),
  };
});

/** `DeveloperModeState` and `DeveloperModeControl` over one store, file and lease count. */
export const developerModeLayer = (options: DeveloperModeOptions) =>
  Layer.effectContext(
    Effect.map(build(options), ({ state, control }) =>
      Context.make(DeveloperModeState, state).pipe(Context.add(DeveloperModeControl, control))
    )
  );

/** `POLARIS_DEVELOPER_MODE`: `off` or `on` overrides the from-source check; anything else keeps it. */
export const DEVELOPER_MODE_ENV = "POLARIS_DEVELOPER_MODE";

/** Whether this Daemon counts as run from source, `override` first (README.md). */
export const fromSourceFor = (override: string | undefined, embedded: boolean): boolean =>
  Match.value(override).pipe(
    Match.when("off", () => false),
    Match.when("on", () => true),
    Match.orElse(() => !embedded)
  );

/** A Daemon run from source rather than from a compiled `polaris` binary, unless overridden. */
export const runsFromSource = (): boolean =>
  fromSourceFor(process.env[DEVELOPER_MODE_ENV], isEmbeddedPath(import.meta.path));

/** The Host's Developer Mode, stored in `~/.polaris/developer-mode.json`; the env is read once. */
export const DeveloperModeLive = Layer.unwrap(
  Effect.sync(() =>
    developerModeLayer({
      file: join(paths().root, "developer-mode.json"),
      fromSource: runsFromSource(),
    })
  )
);
