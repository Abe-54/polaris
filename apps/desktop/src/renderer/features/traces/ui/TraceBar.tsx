/**
 * The 34px trace bar (DESIGN.md, Traces → Trace bar; Paper T1), like Data's connection bar:
 * `TRACE`, the root span, service, duration, span and service counts and the trace id, then
 * "Add to agent session ⌘L", which puts a reference to the trace (and selected span) in the draft.
 */
import { MAX_DRAFT_LENGTH, type TraceDetail } from "@polaris/protocol";
import { Kbd, PixelCheckIcon, showToast } from "@polaris/ui";
import { useCallback, useEffect } from "react";
import { commandShortcut } from "../../../../shared/keymap.ts";
import { useApp, useCommands, useShellActions } from "../../../shell/hooks.ts";
import { updateDraft } from "../../session/state.ts";
import { useOpenTrace } from "../model/openTrace.ts";
import { appendReference, traceReference } from "../model/reference.ts";
import type { TracesSessionKey } from "../model/session.ts";
import { durationLabel, shortHex } from "../model/waterfall/time.ts";
import type { TracesSlotProps } from "./slots.ts";

const count = (n: number, one: string) =>
  `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

const useAddTrace = (at: TracesSessionKey, detail: TraceDetail | null, spanId: string | null) => {
  const { hostKey, sessionId } = at;
  const title = useApp((s) => s.hostModels[hostKey]?.sessions.get(sessionId)?.session.title);
  const { setMode, selectSession } = useShellActions();

  return useCallback(() => {
    if (detail === null) return;
    const span = spanId === null ? null : (detail.spans.find((s) => s.id === spanId) ?? null);
    const text = traceReference(detail.summary, span);
    let fits = false;

    updateDraft(hostKey, sessionId, (draft) => {
      const next = appendReference(draft, text);

      fits = next.length <= MAX_DRAFT_LENGTH;

      return fits ? next : draft;
    });
    const name = title === undefined || title === "" ? "the agent session" : title;

    showToast({
      source: "starlight",
      icon: <PixelCheckIcon size={16} />,
      title: fits
        ? `Added the ${span === null ? "trace" : "span"} to ${name}`
        : `The draft in ${name} is full`,
      message: fits
        ? "It's in the composer; nothing is sent yet."
        : `A draft holds ${MAX_DRAFT_LENGTH.toLocaleString("en-US")} characters. Send or shorten it, then add the trace again.`,
      action: {
        label: "Open session",
        onAction: () => {
          selectSession({ hostKey, sessionId });
          setMode("orchestrate");
        },
      },
    });
  }, [detail, spanId, hostKey, sessionId, title, setMode, selectSession]);
};

export const TraceBar = ({ at, traceId, spanId }: TracesSlotProps) => {
  const detail = useOpenTrace(at, traceId);
  const add = useAddTrace(at, detail, spanId);
  const commands = useCommands();

  useEffect(
    () =>
      detail === null ? undefined : commands.register({ "traces.addToSession": { run: add } }),
    [commands, detail, add]
  );

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
          {summary.root}
        </span>
        {` · ${facts.join(" · ")} · `}
        <span title={summary.id}>{shortHex(summary.id)}</span>
        {summary.partial ? (
          <span data-testid="trace-bar-partial"> · partial: some spans were removed</span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={add}
        data-testid="trace-add-to-session"
        className="text-caption text-text-subtle hover:text-text-default focus-visible:ring-starlight rounded-control flex shrink-0 cursor-default items-center gap-1.5 px-1 outline-none focus-visible:ring-2"
      >
        Add to agent session
        <Kbd variant="plain">{commandShortcut("traces.addToSession")}</Kbd>
      </button>
    </div>
  );
};
