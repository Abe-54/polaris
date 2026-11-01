import { AttachButton } from "./AttachButton.tsx";
/**
 * "Restart ‹service› with profiling" (DESIGN.md, Traces → Sidebar; Paper T2): restarts the open
 * (else newest) trace's root service with profiling on. The Daemon decides whether Polaris started
 * that process; its refusal shows here as it says it, never as success.
 */
import type { TraceDetail } from "@polaris/protocol";
import { useState } from "react";
import type { IpcError } from "../../../../../shared/api.ts";
import { useTrace, useTraces } from "../../data/hooks.tsx";
import { useProfilesApi } from "../../data/profiles.tsx";
import { useOpenTrace } from "../../model/openTrace.ts";
import { restartTarget } from "../../model/profile/restart.ts";
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

type Restart =
  | { readonly kind: "idle" | "pending" }
  | { readonly kind: "refused"; readonly error: IpcError };

export const RestartButton = ({
  at,
  traceId,
}: {
  readonly at: TracesSessionKey;
  readonly traceId: string | null;
}) => {
  const api = useProfilesApi();
  const target = restartTarget(useTargetTrace(at, traceId));
  const [state, setState] = useState<Restart>({ kind: "idle" });

  if (target === null)
    return (
      <p className="text-caption text-text-subtle px-2 py-1" data-testid="profiles-no-target">
        Restart with profiling needs a trace from the running service
      </p>
    );

  const restart = () => {
    setState({ kind: "pending" });
    void api.restart(at, target.pid).then((result) => {
      if (result.ok) {
        setState({ kind: "idle" });
        selectProfile(at, result.value);
      } else setState({ kind: "refused", error: result.error });
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <AttachButton at={at} pid={target.pid} service={target.service} />
      <button
        type="button"
        onClick={restart}
        disabled={state.kind === "pending"}
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
