/**
 * An Agent Session's Review reads its route timings (`traces.compare`) when it opens, when the
 * Turn picked changes and when a Turn ends; never on a timer, and never on a Daemon without the
 * capability. A row opens its Turn's newest trace of that route in Traces (⌘5).
 */
import { type SessionId, TRACES_COMPARE_CAPABILITY, type TurnId } from "@polaris/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HostView } from "../../../../shared/api.ts";
import { useShellActions } from "../../../shell/hooks.ts";
import type { TurnView } from "../../../store/sessionModel.ts";
import { hasCapability } from "../../session/hooks.ts";
import { selectTrace, type TracesApi, useTracesApi } from "../../traces/index.ts";
import type { ReviewTurn, TurnPick } from "../data/source.ts";
import {
  compareCaption,
  type ComparePlan,
  comparePlan,
  openTurn,
  type RouteRow,
  routeRows,
  selectors,
  type TracesAnswer,
} from "./model.ts";

export interface ReviewTracesInput {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly host: HostView | undefined;
  readonly turns: ReadonlyArray<ReviewTurn>;
  readonly pending: ReadonlyArray<ReviewTurn>;
  readonly pick: TurnPick;
  readonly views: ReadonlyArray<TurnView>;
}

export interface ReviewTraces {
  readonly answer: TracesAnswer;
  /** The plan `answer` answers: while another pick loads, the last one's. */
  readonly plan: ComparePlan;
  /** Opens the row's Turn's newest trace of its route in Traces (⌘5). */
  readonly onOpenRoute: (row: RouteRow) => void;
}

type At = { readonly hostKey: string; readonly sessionId: SessionId };

/** One Turn's newest trace whose root is exactly `row`'s: the route filter is a glob. */
const newestInTurn = (api: TracesApi, at: At, row: RouteRow, turn: TurnId) =>
  new Promise<string | null>((resolve) => {
    let done = false;
    let stop: (() => void) | null = null;

    const finish = (id: string | null) => {
      if (done) return;
      done = true;
      resolve(id);
      stop?.();
    };

    stop = api.watch(
      at,
      { turn, route: row.route, service: row.service },
      {
        next: (snapshot) =>
          finish(
            snapshot.traces.find((t) => t.root === row.route && t.service === row.service)?.id ??
              null
          ),
        end: () => finish(null),
      }
    );

    // A watch may answer before it returns its stop.
    if (done) stop();
  });

/** The newest trace of `row`'s route in its side's Turns, latest Turn first; Traces selects it. */
const openRoute = async (api: TracesApi, at: At, row: RouteRow, plan: ComparePlan) => {
  for (const turn of openTurn(row, plan).turnIds.toReversed()) {
    const id = await newestInTurn(api, at, row, turn);

    if (id !== null) return selectTrace(at, id);
  }
};

interface Seen {
  readonly scope: string;
  readonly key: string;
  readonly answer: TracesAnswer;
  readonly plan: ComparePlan;
}

/** Everything of the plan the request reads: its Turns, and the Host's connection. */
const requestKey = (scope: string, plan: ComparePlan, epoch: number) =>
  [
    scope,
    epoch,
    plan.before?.number ?? "",
    ...(plan.before?.turnIds ?? []),
    "",
    ...plan.after.turnIds,
  ].join("\u0000");

const useComparison = (
  api: TracesApi,
  at: At,
  plan: ComparePlan | null,
  supported: boolean,
  { ended, epoch }: { readonly ended: number; readonly epoch: number }
): { readonly answer: TracesAnswer; readonly plan: ComparePlan } | null => {
  const [seen, setSeen] = useState<Seen | null>(null);
  const { hostKey, sessionId } = at;
  const latest = useRef(plan);

  latest.current = plan;
  const scope = `${hostKey}\u0000${sessionId}`;
  const key = plan === null ? null : requestKey(scope, plan, epoch);

  useEffect(() => {
    // `key` names everything of the plan the request reads.
    const asked = latest.current;

    if (!supported || asked === null || key === null) return undefined;
    let live = true;
    const { a, b } = selectors(asked);

    void api.compare({ hostKey, sessionId }, a, b).then((result) => {
      if (!live) return;

      setSeen({
        scope,
        key,
        plan: asked,
        answer: result.ok
          ? {
              status: "ready",
              rows: routeRows(result.value, asked),
              caption: compareCaption(asked),
            }
          : { status: "failed", message: result.error.message },
      });
    });

    return () => {
      live = false;
    };
  }, [api, hostKey, sessionId, scope, key, supported, ended]);

  return useMemo(() => {
    if (!supported || seen === null || seen.scope !== scope) return null;

    return seen.key === key
      ? { answer: seen.answer, plan: seen.plan }
      : { answer: { ...seen.answer, loading: true }, plan: seen.plan };
  }, [supported, seen, scope, key]);
};

export const useReviewTraces = ({
  hostKey,
  sessionId,
  host,
  turns,
  pending,
  pick,
  views,
}: ReviewTracesInput): ReviewTraces | null => {
  const api = useTracesApi();
  const actions = useShellActions();
  const supported = hasCapability(host, TRACES_COMPARE_CAPABILITY);
  const ended = views.filter((v) => v.turn.status !== "working").length;
  const plan = useMemo(() => comparePlan(turns, pending, pick), [turns, pending, pick]);
  const epoch = host?.status.epoch ?? 0;
  const shown = useComparison(api, { hostKey, sessionId }, plan, supported, { ended, epoch });
  const shownPlan = shown?.plan ?? null;

  const onOpenRoute = useCallback(
    (row: RouteRow) => {
      if (shownPlan === null) return;
      actions.selectSession({ hostKey, sessionId });
      actions.setMode("traces");
      void openRoute(api, { hostKey, sessionId }, row, shownPlan);
    },
    [actions, api, hostKey, sessionId, shownPlan]
  );

  return useMemo(
    () => (shown === null ? null : { answer: shown.answer, plan: shown.plan, onOpenRoute }),
    [shown, onOpenRoute]
  );
};
