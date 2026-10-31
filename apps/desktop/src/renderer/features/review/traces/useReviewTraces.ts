/**
 * An Agent Session's Review reads its route timings (`traces.compare`) when it opens, when the
 * Turn picked changes and when a Turn ends; never on a timer, and never on a Daemon without the
 * capability. A row opens its Turn's newest trace of that route in Traces (⌘5).
 */
import { type SessionId, TRACES_COMPARE_CAPABILITY } from "@polaris/protocol";
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
  readonly plan: ComparePlan;
  /** Opens the row's Turn's newest trace of its route in Traces (⌘5). */
  readonly onOpenRoute: (row: RouteRow) => void;
}

type At = { readonly hostKey: string; readonly sessionId: SessionId };

/** The newest trace of `row`'s route in its Turn, once; Traces opens at once and selects it. */
const openRoute = (api: TracesApi, at: At, row: RouteRow, plan: ComparePlan) => {
  const filter = { turn: openTurn(row, plan).turnId, route: row.route, service: row.service };
  let done = false;
  let stop: (() => void) | null = null;

  stop = api.watch(
    at,
    { ...filter, limit: 1 },
    {
      next: (snapshot) => {
        if (done) return;
        done = true;
        const newest = snapshot.traces[0];

        if (newest !== undefined) selectTrace(at, newest.id);
        stop?.();
      },
      end: () => {
        done = true;
      },
    }
  );

  // A watch may answer before it returns its stop.
  if (done) stop();
};

const useComparison = (
  api: TracesApi,
  at: At,
  plan: ComparePlan | null,
  supported: boolean,
  ended: number
): TracesAnswer | null => {
  const [seen, setSeen] = useState<{ readonly key: string; readonly answer: TracesAnswer } | null>(
    null
  );

  const { hostKey, sessionId } = at;
  const latest = useRef(plan);

  latest.current = plan;

  const key =
    plan === null
      ? null
      : `${hostKey}\u0000${sessionId}\u0000${plan.before?.turnId ?? ""}\u0000${plan.after.turnId}`;

  useEffect(() => {
    // `key` names everything of the plan the request reads.
    const asked = latest.current;

    if (!supported || asked === null || key === null) return undefined;
    let live = true;
    const { a, b } = selectors(asked);

    void api.compare({ hostKey, sessionId }, a, b).then((result) => {
      if (!live) return;

      setSeen({
        key,
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
  }, [api, hostKey, sessionId, key, supported, ended]);

  return supported && seen !== null && seen.key === key ? seen.answer : null;
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
  const answer = useComparison(api, { hostKey, sessionId }, plan, supported, ended);

  const onOpenRoute = useCallback(
    (row: RouteRow) => {
      if (plan === null) return;
      actions.selectSession({ hostKey, sessionId });
      actions.setMode("traces");
      openRoute(api, { hostKey, sessionId }, row, plan);
    },
    [actions, api, hostKey, sessionId, plan]
  );

  return useMemo(
    () => (answer === null || plan === null ? null : { answer, plan, onOpenRoute }),
    [answer, plan, onOpenRoute]
  );
};
