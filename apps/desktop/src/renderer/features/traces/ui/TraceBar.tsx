/**
 * The 34px trace bar (DESIGN.md, Traces → Trace bar; Paper T1), like Data's connection bar:
 * `TRACE`, the root span, service, duration, span and service counts and the trace id, then
 * "Add to agent session ⌘L", which puts a reference to the trace (and selected span) in the draft.
 * A trace a Send started says "from Requests" and offers "Resend in Requests ⌘6" (Paper Q3).
 */
import { REQUESTS_CAPABILITY, type Send, SendLookup, type TraceDetail } from "@polaris/protocol";
import { Kbd } from "@polaris/ui";
import { useCallback, useEffect, useState } from "react";
import { commandShortcut } from "../../../../shared/keymap.ts";
import { useApp, useCommands, useShellActions } from "../../../shell/hooks.ts";
import { showBidi } from "../../data/grid/value.ts";
import { loadSend, useRequestsApi } from "../../requests/index.ts";
import { useOpenTrace } from "../model/openTrace.ts";
import { useProfileFocused } from "../model/profile/store.ts";
import { traceReference } from "../model/reference.ts";
import { OTHER_SESSION } from "../model/sidebar.ts";
import type { TracesSessionKey } from "../model/session.ts";
import { durationLabel, shortHex } from "../model/waterfall/time.ts";
import type { TracesSlotProps } from "./slots.ts";
import { useAddToSession } from "./useAddToSession.tsx";

const count = (n: number, one: string) =>
  `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

const useAddTrace = (at: TracesSessionKey, detail: TraceDetail | null, spanId: string | null) => {
  const add = useAddToSession(at);
  const { hostKey, sessionId } = at;
  const owner = detail?.summary.turn?.sessionId ?? sessionId;
  const ownerTitle = useApp((s) => s.hostModels[hostKey]?.sessions.get(owner)?.session.title);
  // A trace from another session's Turn names that session, so the agent reads the right Turn.
  const named = ownerTitle === undefined || ownerTitle === "" ? OTHER_SESSION : ownerTitle;
  const other = owner === sessionId ? null : named;

  return useCallback(() => {
    if (detail === null) return;
    const span = spanId === null ? null : (detail.spans.find((s) => s.id === spanId) ?? null);

    add(traceReference(detail.summary, span, other), span === null ? "trace" : "span");
  }, [add, detail, spanId, other]);
};

/** Sends' root spans are service `polaris`; Self-Traces never come from a Send. */
const SEND_SERVICE = "polaris";

/** The Send that started the trace, looked up only where one could have; null for any other. */
const useStartingSend = (at: TracesSessionKey, detail: TraceDetail | null): Send | null => {
  const api = useRequestsApi();
  const { hostKey, sessionId, scope } = at;
  const capabilities = useApp((s) => s.hosts.find((h) => h.key === hostKey)?.status.capabilities);
  const capable = capabilities?.includes(REQUESTS_CAPABILITY) === true;
  const id = detail?.summary.id ?? null;
  const candidate = capable && scope === undefined && detail?.summary.service === SEND_SERVICE;
  const [found, setFound] = useState<{ traceId: string; send: Send } | null>(null);

  useEffect(() => {
    if (!candidate || id === null) return undefined;
    let live = true;

    void api
      .getSend({ hostKey, sessionId }, SendLookup.cases.ByTrace.make({ traceId: id }))
      .then((result) => {
        if (live && result.ok) setFound({ traceId: id, send: result.value });
      });

    return () => {
      live = false;
    };
  }, [api, hostKey, sessionId, id, candidate]);

  return candidate && found !== null && found.traceId === id ? found.send : null;
};

const useResend = (at: TracesSessionKey, send: Send | null) => {
  const { setMode } = useShellActions();
  const { hostKey, sessionId } = at;

  return useCallback(() => {
    if (send === null) return;
    loadSend({ hostKey, sessionId }, send);
    setMode("requests");
  }, [send, hostKey, sessionId, setMode]);
};

const ACTION =
  "text-caption text-text-subtle hover:text-text-default focus-visible:ring-starlight rounded-control flex shrink-0 cursor-default items-center gap-1.5 px-1 outline-none focus-visible:ring-2";

export const TraceBar = ({ at, traceId, spanId }: TracesSlotProps) => {
  const detail = useOpenTrace(at, traceId);
  const add = useAddTrace(at, detail, spanId);
  const send = useStartingSend(at, detail);
  const resend = useResend(at, send);
  const commands = useCommands();
  // The open Profile takes ⌘L while focus is in it, however often this re-registers.
  const profileFocused = useProfileFocused(at);

  useEffect(() => {
    return detail === null || profileFocused
      ? undefined
      : commands.register({ "traces.addToSession": { run: add } });
  }, [commands, detail, add, profileFocused]);

  // ⌘6 still opens Requests; on a Send's trace it opens with that Send's request loaded.
  useEffect(() => {
    return send === null ? undefined : commands.register({ "view.requests": { run: resend } });
  }, [commands, send, resend]);

  if (detail === null) return null;
  const { summary } = detail;

  const facts = [
    summary.service,
    durationLabel(summary.durationMs),
    count(summary.spans, "span"),
    count(summary.services.length, "service"),
  ];

  return (
    <div
      data-testid="trace-bar"
      className="bg-well ring-hairline rounded-row mx-2 mt-2 flex h-[34px] shrink-0 items-center gap-2.5 px-3 ring-1 ring-inset"
    >
      <span className="text-micro text-text-subtle shrink-0 font-mono font-medium tracking-[0.06em]">
        TRACE
      </span>
      <span className="bg-hairline h-3.5 w-px shrink-0" />
      <span className="text-code-inline text-text-default min-w-0 flex-1 truncate font-mono">
        <span className="text-text-strong font-medium" title={summary.root}>
          {showBidi(summary.root)}
        </span>
        {` · ${facts.join(" · ")} · `}
        <span title={summary.id}>{shortHex(summary.id)}</span>
        {summary.partial ? (
          <span data-testid="trace-bar-partial"> · partial: some spans were removed</span>
        ) : null}
        {send === null ? null : <span data-testid="trace-bar-from-requests"> · from Requests</span>}
      </span>
      {send === null ? null : (
        <button type="button" onClick={resend} data-testid="trace-resend" className={ACTION}>
          Resend in Requests
          <Kbd variant="plain">{commandShortcut("view.requests")}</Kbd>
        </button>
      )}
      <button type="button" onClick={add} data-testid="trace-add-to-session" className={ACTION}>
        Add to agent session
        <Kbd variant="plain">{commandShortcut("traces.addToSession")}</Kbd>
      </button>
    </div>
  );
};
