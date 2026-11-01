/**
 * Review's route timings (useReviewTraces) on a TracesApi backed by the real Daemon trace store
 * and `compareForSession`, so the desktop is tested against what the Daemon answers (RPU P8U).
 */
import "../../../test/dom.testing.ts";
import {
  Capability,
  type ConnectionState,
  HostId,
  type SessionId,
  type TraceCompareSelector,
  type TraceComparison,
  type TraceFilter,
  type TraceSummary,
  type TurnId,
} from "@polaris/protocol";
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { Effect } from "effect";
import { createStore } from "zustand/vanilla";
import type { HostView, Result } from "../../../../shared/api.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import { type TracesApi, TracesLayer } from "../../traces/index.ts";
import { fixtureSnapshot } from "../../traces/preview/fixtureApi.ts";
import type { ReviewTurn, TurnPick } from "../data/source.ts";
import { type ReviewTraces, type ReviewTracesInput, useReviewTraces } from "./useReviewTraces.ts";

/** The Daemon's trace store, as far as these tests reach into it. */
export interface DaemonStore {
  readonly list: (
    checkout: string,
    filter?: TraceFilter
  ) => Effect.Effect<{ readonly traces: ReadonlyArray<TraceSummary> }, unknown>;
}

interface IngestOptions {
  readonly route?: string;
  readonly offset?: bigint;
}

/** apps/daemon/src/traces: `compareForSession`, and compare.testing's store with Turns 0–3. */
interface DaemonTraces {
  readonly compareForSession: (
    store: DaemonStore,
    sessions: { readonly session: () => Effect.Effect<unknown> },
    sessionId: SessionId,
    a: TraceCompareSelector,
    b: TraceCompareSelector
  ) => Effect.Effect<TraceComparison, { code: string; message: string; fix: string }>;
  readonly withComparisons: (
    run: (fixture: {
      readonly store: DaemonStore;
      readonly ingest: (
        turn: number,
        durations: ReadonlyArray<number>,
        options?: IngestOptions
      ) => Promise<ReadonlyArray<string>>;
    }) => Promise<void>
  ) => Promise<void>;
  /** Live: each withComparisons run replaces it. */
  readonly compareContext: {
    readonly checkout: string;
    readonly turns: ReadonlyArray<{ readonly turn: { readonly id: TurnId } }>;
  };
  readonly TEST_SESSION: SessionId;
}

const DAEMON_TRACES = new URL("../../../../../../daemon/src/traces/", import.meta.url);

/**
 * Loaded at run time so the renderer's DOM-typed tsconfig never compiles Daemon sources; if
 * the Daemon's signatures drift from DaemonTraces, these tests fail rather than typecheck.
 */
/** One of the Daemon's trace modules; `M` names the exports these tests use. */
const daemonModule = <M,>(file: string): Promise<M> =>
  // SAFETY: `file` is one of the Daemon's compare.ts, compare.testing.ts and testing.ts, whose
  // exports DaemonTraces mirrors; a drift breaks these tests at their first call.
  import(new URL(file, DAEMON_TRACES).href) as Promise<M>;

const load = async (): Promise<DaemonTraces> => {
  const [compare, testing, fixtures] = await Promise.all([
    daemonModule<Pick<DaemonTraces, "compareForSession">>("compare.ts"),
    daemonModule<Pick<DaemonTraces, "withComparisons" | "compareContext">>("compare.testing.ts"),
    daemonModule<Pick<DaemonTraces, "TEST_SESSION">>("testing.ts"),
  ]);

  return {
    compareForSession: compare.compareForSession,
    withComparisons: testing.withComparisons,
    get compareContext() {
      return testing.compareContext;
    },
    TEST_SESSION: fixtures.TEST_SESSION,
  };
};

export const daemon = await load();

export const HOST = "local";

export const host = (
  state: ConnectionState = "connected",
  epoch = 1,
  capabilities: ReadonlyArray<Capability> = Capability.literals
): HostView => ({
  key: HOST,
  label: "Mac Studio",
  colour: null,
  alias: null,
  kind: "local",
  proofHarness: false,
  status: {
    state,
    failure: null,
    attempt: state === "connected" ? 0 : 2,
    since: 0,
    nextAttemptAt: null,
    host: {
      hostId: HostId.make("h"),
      hostname: "studio",
      platform: "darwin-arm64",
      daemonVersion: "0.0.0",
      homeDir: "/Users/lucas",
      startedAt: "2026-10-31T00:00:00.000Z",
    },
    capabilities,
    epoch,
    latencyMs: null,
    lastSeenAt: null,
  },
});

const turnInfo = (id: TurnId, index: number) => ({
  id,
  index,
  prompt: "",
  checkpointBefore: null,
  checkpointAfter: null,
  status: "completed" as const,
});

/** Review Turns over compare.testing's Turns (compare-0…3); each group lists its Turn indexes. */
export const reviewTurns = (groups: ReadonlyArray<ReadonlyArray<number>>): ReviewTurn[] =>
  groups.map((group, at) => {
    const ids = group.map((i) => daemon.compareContext.turns[i]!.turn.id);

    return {
      id: ids[0]!,
      number: at + 1,
      prompt: null,
      turns: ids.map((id, k) => turnInfo(id, group[k]!)),
    };
  });

const asResult = <A,>(effect: Effect.Effect<A, { code: string; message: string; fix: string }>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.map((value): Result<A> => ({ ok: true, value })),
      Effect.catch((e) =>
        Effect.succeed<Result<A>>({
          ok: false,
          error: { code: e.code, message: e.message, fix: e.fix },
        })
      )
    )
  );

/** `traces.compare` and a one-shot `traces.watch` answered by the real Daemon store. */
export const daemonApi = (store: DaemonStore): TracesApi => {
  const sessions = { session: () => Effect.succeed(daemon.compareContext) };

  return {
    compare: (_at, a: TraceCompareSelector, b: TraceCompareSelector) =>
      asResult(daemon.compareForSession(store, sessions, daemon.TEST_SESSION, a, b)),
    watch: (_at, filter, on) => {
      void Effect.runPromise(store.list(daemon.compareContext.checkout, filter)).then((page) =>
        on.next({ ...fixtureSnapshot("traces"), ...page })
      );

      return () => undefined;
    },
    get: () => Promise.reject(new Error("unused")),
    span: () => Promise.reject(new Error("unused")),
  };
};

export interface MountInput {
  readonly turns: ReadonlyArray<ReviewTurn>;
  readonly pick: TurnPick;
  readonly host?: HostView;
}

/** useReviewTraces in the app's providers, read through `use`; rerender to change the pick or Host. */
export const mountWith = <R,>(
  api: TracesApi,
  input: MountInput,
  use: (traces: ReviewTraces | null) => R
) => {
  const store = createStore<AppState>(() => ({ ...initialState, hosts: [host()] }));
  const navigation = createNavigation({ app: store, storage: null });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppProvider
      value={{
        connection: {
          store,
          openSession: () => () => undefined,
          setDensity: () => undefined,
          setAppearance: () => undefined,
        },
        navigation,
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TracesLayer api={api}>{children}</TracesLayer>
    </AppProvider>
  );

  const props = (p: MountInput): ReviewTracesInput => ({
    hostKey: HOST,
    sessionId: daemon.TEST_SESSION,
    host: p.host ?? host(),
    turns: p.turns,
    pending: p.turns,
    pick: p.pick,
    views: [],
  });

  const hook = renderHook((p: MountInput) => use(useReviewTraces(props(p))), {
    wrapper,
    initialProps: input,
  });

  return { ...hook, navigation };
};

export const mount = (api: TracesApi, input: MountInput) => mountWith(api, input, (t) => t);
