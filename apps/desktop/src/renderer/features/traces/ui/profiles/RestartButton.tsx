/**
 * "Restart ‹service› with profiling" (DESIGN.md, Traces → Sidebar; Paper T2): restarts the open
 * (else newest) trace's root service with profiling on. The Daemon decides whether Polaris started
 * that process; its refusal shows here as it says it, never as success. It waits for Connected
 * and says what it stops (rule/remote-is-normal, rule/destructive-names-object).
 */
import type { TraceDetail } from "@polaris/protocol";
import { useConnectionOf, useTrace, useTraces } from "../../data/hooks.tsx";
import { useProfilesApi } from "../../data/profiles.tsx";
import { useOpenTrace } from "../../model/openTrace.ts";
import { restartTarget } from "../../model/profile/restart.ts";
import { startRestart, useRestart } from "../../model/profile/restarts.ts";
import { selectProfile } from "../../model/profile/store.ts";
import type { TracesSessionKey } from "../../model/session.ts";

const NEWEST = { limit: 1 } as const;

/** The open trace as the waterfall loaded it, else the newest one, read only for its processes. */
const useTargetTrace = (at: TracesSessionKey, traceId: string | null): TraceDetail | null => {
  const open = useOpenTrace(at, traceId);
  const newest = useTraces(at, NEWEST);

  const newestId =
    open === null && newest.status === "ready" ? (newest.value.traces[0]?.id ?? null) : null;

  const loaded = useTrace(at, newestId);

  if (open !== null) return open;

  return loaded.status === "ready" ? loaded.value : null;
};

export const RestartButton = ({
  at,
  traceId,
}: {
  readonly at: TracesSessionKey;
  readonly traceId: string | null;
}) => {
  const api = useProfilesApi();
  const target = restartTarget(useTargetTrace(at, traceId));
  const state = useRestart(at, target);
  const { connected } = useConnectionOf(at.hostKey);

  if (target === null)
    return (
      <p className="text-caption text-text-subtle px-2 py-1" data-testid="profiles-no-target">
        Restart with profiling needs a trace from the running service
      </p>
    );

  const restart = () =>
    startRestart(
      at,
      target,
      () => api.restart(at, target.pid),
      (profile) => selectProfile(at, profile)
    );

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={restart}
        disabled={state.kind === "pending" || !connected}
        data-testid="profiles-restart"
        title={`Restart ${target.service} (pid ${target.pid}) with profiling`}
        className="border-text-strong/12 hover:bg-fill-hover focus-visible:ring-starlight flex h-[30px] w-full shrink-0 cursor-default items-center gap-1.5 rounded-full border px-2.5 outline-none focus-visible:ring-2 disabled:opacity-(--opacity-dimmed)"
      >
        <span className="bg-text-subtle size-1.5 shrink-0 rounded-full" aria-hidden />
        <span className="text-caption text-text-default min-w-0 truncate font-medium">
          {state.kind === "pending"
            ? `Restarting ${target.service}…`
            : `Restart ${target.service} with profiling`}
        </span>
      </button>
      <p className="text-caption text-text-subtle px-2" data-testid="profiles-restart-consequence">
        {`Stops pid ${target.pid} and starts it again with profiling`}
      </p>
      {state.kind === "refused" ? (
        <div
          className="flex flex-col gap-0.5 px-2 py-1"
          role="alert"
          data-testid="profiles-refused"
        >
          <p className="text-caption text-text-default">{state.error.message}</p>
          {state.error.fix === undefined ? null : (
            <p className="text-caption text-text-subtle">{state.error.fix}</p>
          )}
        </div>
      ) : null}
    </div>
  );
};
