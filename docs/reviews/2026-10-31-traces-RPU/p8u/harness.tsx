/** @jsxImportSource ../../../../apps/desktop/node_modules/react */
/**
 * P8U repro harness: Review's route timings (useReviewTraces) on a TracesApi backed by the real
 * Daemon trace store and `compareForSession`, so the desktop reads what the Daemon answers.
 */
import "../../../../apps/desktop/src/renderer/test/dom.testing.ts";
import {
  Capability,
  type ConnectionState,
  HostId,
  type TraceCompareSelector,
  type TurnId,
} from "../../../../packages/protocol/src/index.ts";
import type { ReactNode } from "react";
import { Effect, createStore, renderHook } from "./deps.ts";
import type { HostView, Result } from "../../../../apps/desktop/src/shared/api.ts";
import { createCommandRegistry } from "../../../../apps/desktop/src/renderer/routes/commands.ts";
import { createNavigation } from "../../../../apps/desktop/src/renderer/routes/navigation.ts";
import { AppProvider } from "../../../../apps/desktop/src/renderer/shell/hooks.ts";
import { type AppState, initialState } from "../../../../apps/desktop/src/renderer/store/store.ts";
import {
  type TracesApi,
  TracesLayer,
} from "../../../../apps/desktop/src/renderer/features/traces/index.ts";
import { fixtureSnapshot } from "../../../../apps/desktop/src/renderer/features/traces/preview/fixtureApi.ts";
import type {
  ReviewTurn,
  TurnPick,
} from "../../../../apps/desktop/src/renderer/features/review/data/source.ts";
import {
  type ReviewTraces,
  type ReviewTracesInput,
  useReviewTraces,
} from "../../../../apps/desktop/src/renderer/features/review/traces/useReviewTraces.ts";
import { compareForSession } from "../../../../apps/daemon/src/traces/compare.ts";
import { compareContext } from "../../../../apps/daemon/src/traces/compare.testing.ts";
import type { TraceStore } from "../../../../apps/daemon/src/traces/store.ts";
import { TEST_SESSION } from "../../../../apps/daemon/src/traces/testing.ts";

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
    const ids = group.map((i) => compareContext.turns[i]!.turn.id);

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
export const daemonApi = (store: TraceStore["Service"]): TracesApi => {
  const sessions = { session: () => Effect.succeed(compareContext) };

  return {
    compare: (_at, a: TraceCompareSelector, b: TraceCompareSelector) =>
      asResult(compareForSession(store, sessions, TEST_SESSION, a, b)),
    watch: (_at, filter, on) => {
      void Effect.runPromise(store.list(compareContext.checkout, filter)).then((page) =>
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
    sessionId: TEST_SESSION,
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
