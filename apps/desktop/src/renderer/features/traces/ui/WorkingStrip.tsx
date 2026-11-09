/**
 * The Working strip under the trace bar (DESIGN.md, Traces → Working strip; Paper T1): while the
 * agent session runs a Turn, "‹session› is working" in its Harness hue, "Claude Code · turn 12 ·
 * 14 traces", and Follow, which opens each new trace of that Turn as it arrives.
 */
import type { HarnessKind, SessionId } from "@polaris/protocol";
import { Dither, harnessHue, harnessTextVar, hueVar, LiveDither } from "@polaris/ui";
import { useEffect, useMemo, useRef } from "react";
import { useApp } from "../../../shell/hooks.ts";
import { useTraces } from "../data/hooks.tsx";
import { runningTurnTraces, setFollow, turnTracesLabel, useFollow } from "../model/follow.ts";
import type { TracesSessionKey } from "../model/session.ts";
import { selectTrace } from "../model/store.ts";
import type { TracesSlotProps } from "./slots.ts";

const FollowToggle = ({ at }: { readonly at: TracesSessionKey }) => {
  const follow = useFollow(at);

  return (
    <label className="text-label text-text-default hover:bg-fill-hover flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-full px-2.5">
      <input
        type="checkbox"
        checked={follow}
        onChange={(event) => setFollow(at, event.target.checked)}
        className="peer sr-only"
        data-testid="traces-follow"
      />
      <span
        aria-hidden="true"
        className="peer-focus-visible:outline-starlight border-text-subtle peer-checked:bg-text-strong peer-checked:border-text-strong text-bg flex size-3.5 items-center justify-center rounded-[4px] border peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1"
      >
        {follow ? (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              d="M2 5.2l2 2L8 3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </span>
      Follow
    </label>
  );
};

interface Running {
  readonly title: string;
  readonly harness: HarnessKind;
  readonly turn: number;
}

/** The session's title, Harness and Turn while it is Working; null otherwise. */
const useRunning = (hostKey: string, sessionId: SessionId): Running | null => {
  const session = useApp((s) => s.hostModels[hostKey]?.sessions.get(sessionId)?.session);

  return useMemo(
    () =>
      session === undefined || session.state !== "working" || session.turnCount < 1
        ? null
        : {
            title: session.title === "" ? "This agent session" : session.title,
            harness: session.harness,
            turn: session.turnCount,
          },
    [session]
  );
};

const Strip = ({ at, running }: { readonly at: TracesSessionKey; readonly running: Running }) => {
  const snapshot = useTraces(at);
  const follow = useFollow(at);
  const { harness, turn } = running;

  const traces = useMemo(
    () =>
      snapshot.status === "ready"
        ? runningTurnTraces(snapshot.value.traces, snapshot.value.total, at.sessionId, turn)
        : null,
    [snapshot, at.sessionId, turn]
  );

  const newest = traces?.newest?.id ?? null;
  const opened = useRef<string | null>(null);

  // Follow opens the newest trace once: turning it on opens the latest, then each new one.
  useEffect(() => {
    if (!follow) opened.current = null;
    else if (newest !== null && newest !== opened.current) {
      opened.current = newest;
      selectTrace(at, newest);
    }
  }, [at, follow, newest]);

  const facts = [harnessHue(harness).name, `turn ${turn}`];

  if (traces !== null) facts.push(turnTracesLabel(traces));

  return (
    <div
      role="status"
      data-testid="traces-working-strip"
      className="relative isolate mt-2 flex h-[42px] shrink-0 items-center gap-2.5 overflow-clip border-y pr-2 pl-4"
      style={{
        borderTopColor: `color-mix(in srgb, ${hueVar(harness)} 12%, transparent)`,
        borderBottomColor: `color-mix(in srgb, ${hueVar(harness)} 20%, transparent)`,
      }}
    >
      <LiveDither harness={harness} active className="-z-10" />
      <Dither hue={harness} size={12} moving />
      <span
        className="text-label min-w-0 shrink truncate"
        style={{ color: harnessTextVar(harness) }}
        title={running.title}
      >
        {`${running.title} is working`}
      </span>
      <span className="text-caption text-text-subtle tabular shrink-0">{facts.join(" · ")}</span>
      <span className="flex-1" />
      <FollowToggle at={at} />
    </div>
  );
};

/** Shows while the selected agent session is Working; never over Polaris's own traces. */
export const WorkingStrip = ({ at }: TracesSlotProps) => {
  const running = useRunning(at.hostKey, at.sessionId);

  if (running === null || at.scope === "self") return null;

  return <Strip at={at} running={running} />;
};
