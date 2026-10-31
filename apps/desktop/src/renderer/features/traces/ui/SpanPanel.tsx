/**
 * The 360px span panel (DESIGN.md, Traces → Span panel; Paper T1): `SPAN` and its id with copy
 * and close, the name, service, kind and duration, Open in Data and the code location, then
 * `Fields | Logs n | Events n | Links n`. Shown while a span is selected.
 */
import type { SpanDetail } from "@polaris/protocol";
import { CloseIcon, CopyButton, cn, IconButton } from "@polaris/ui";
import { type ReactNode, useState } from "react";
import { useApp } from "../../../shell/hooks.ts";
import { useSpan } from "../data/hooks.tsx";
import { formatDuration, shortId } from "../model/format.ts";
import type { TracesSessionKey } from "../model/session.ts";
import { codeLocation } from "../model/span/code.ts";
import { spanFieldGroups } from "../model/span/fields.ts";
import { selectSpan, selectTrace } from "../model/store.ts";
import type { TracesSlotProps } from "./slots.ts";
import { SpanActions } from "./span/Actions.tsx";
import { Events } from "./span/Events.tsx";
import { Fields } from "./span/Fields.tsx";
import { Links } from "./span/Links.tsx";
import { Logs } from "./span/Logs.tsx";
import { KICKER, Quiet } from "./span/parts.tsx";

type Tab = "fields" | "logs" | "events" | "links";

const Header = ({
  at,
  spanId,
  copy,
}: {
  readonly at: TracesSessionKey;
  readonly spanId: string;
  readonly copy: string | null;
}) => (
  <div className="flex h-11 shrink-0 items-center gap-2 pr-3 pl-4">
    <span className={cn(KICKER, "text-text-subtle font-medium")}>Span</span>
    <span className="text-code-inline text-text-subtle min-w-0 flex-1 truncate font-mono">
      {shortId(spanId)}
    </span>
    {copy === null ? null : <CopyButton text={copy} label="Copy span id" variant="icon" />}
    <IconButton
      size="sm"
      label="Close span"
      icon={<CloseIcon size={14} />}
      onClick={() => selectSpan(at, null)}
    />
  </div>
);

const TabButton = ({
  on,
  count,
  onClick,
  children,
}: {
  readonly on: boolean;
  readonly count?: number;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) => (
  <button
    type="button"
    role="tab"
    aria-selected={on}
    onClick={onClick}
    className={cn(
      "focus-visible:ring-starlight flex h-[34px] cursor-default items-center gap-[5px] outline-none focus-visible:ring-2 focus-visible:ring-inset",
      on && "shadow-[inset_0_-1px_0_var(--color-text-default)]"
    )}
  >
    <span className={cn("text-caption font-medium", on ? "text-text-strong" : "text-text-subtle")}>
      {children}
    </span>
    {count === undefined ? null : (
      <span className="text-text-faint tabular font-mono text-[11px] leading-4">{count}</span>
    )}
  </button>
);

const Body = ({
  at,
  detail,
  sessionTitle,
}: {
  readonly at: TracesSessionKey;
  readonly detail: SpanDetail;
  readonly sessionTitle: string | null;
}) => {
  const [tab, setTab] = useState<Tab>("fields");
  const { span } = detail;
  const checkout = span.polaris.checkout;

  const openLink = (traceId: string, spanId: string) => {
    selectTrace(at, traceId);
    selectSpan(at, spanId);
  };

  return (
    <>
      <div className="flex shrink-0 flex-col gap-1 px-4 pb-3">
        <h2
          className={cn(
            "text-heading-sm font-mono font-medium [overflow-wrap:anywhere]",
            span.status === "error" ? "text-severity-critical-text" : "text-text-strong"
          )}
          data-testid="span-name"
        >
          {span.name}
        </h2>
        <p className="text-code-inline text-text-subtle font-mono">
          {span.service} · {span.kind} · {formatDuration(span.durationMs)}
        </p>
        {span.status === "error" && span.statusMessage !== "" ? (
          <p className="text-caption text-severity-critical-text [overflow-wrap:anywhere]">
            {span.statusMessage}
          </p>
        ) : null}
      </div>
      <SpanActions at={at} span={span} location={codeLocation(span.attributes, checkout)} />
      <div
        role="tablist"
        aria-label="Span details"
        className="border-hairline flex h-[34px] shrink-0 items-center gap-[18px] border-b px-4"
      >
        <TabButton on={tab === "fields"} onClick={() => setTab("fields")}>
          Fields
        </TabButton>
        <TabButton on={tab === "logs"} count={detail.logCount} onClick={() => setTab("logs")}>
          Logs
        </TabButton>
        <TabButton
          on={tab === "events"}
          count={span.events.length}
          onClick={() => setTab("events")}
        >
          Events
        </TabButton>
        <TabButton on={tab === "links"} count={span.links.length} onClick={() => setTab("links")}>
          Links
        </TabButton>
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto select-text">
        {tab === "fields" ? <Fields groups={spanFieldGroups(span, sessionTitle)} /> : null}
        {tab === "logs" ? (
          <Logs logs={detail.logs} count={detail.logCount} start={span.startTimeUnixNano} />
        ) : null}
        {tab === "events" ? <Events span={span} checkout={checkout} /> : null}
        {tab === "links" ? <Links span={span} onOpen={openLink} /> : null}
      </div>
    </>
  );
};

export const SpanPanel = ({ at, hostKey, traceId, spanId }: TracesSlotProps) => {
  const loaded = useSpan(at, traceId, spanId);
  const sessionId = loaded.status === "ready" ? loaded.value.span.polaris.sessionId : null;

  const sessionTitle = useApp((s) =>
    sessionId === null
      ? null
      : (s.hostModels[hostKey]?.sessions.get(sessionId)?.session.title ?? null)
  );

  if (spanId === null) return null;

  return (
    <aside
      aria-label="Span"
      data-testid="span-panel"
      className="border-hairline bg-panel flex w-[360px] min-w-0 shrink-0 flex-col border-l"
    >
      <Header
        at={at}
        spanId={spanId}
        copy={loaded.status === "ready" ? loaded.value.span.id : null}
      />
      {loaded.status === "loading" ? <Quiet>Reading span…</Quiet> : null}
      {loaded.status === "failed" ? (
        <div className="flex flex-col gap-1 px-4 py-3" data-testid="span-failed">
          <p className="text-caption text-text-default">{loaded.error.message}</p>
          <p className="text-caption text-text-subtle">
            <span className="font-mono">{loaded.error.code}</span>
            {loaded.error.fix === undefined ? "" : ` · ${loaded.error.fix}`}
          </p>
        </div>
      ) : null}
      {loaded.status === "ready" ? (
        // Each span starts on Fields with its own filter.
        <Body
          key={loaded.value.span.id}
          at={at}
          detail={loaded.value}
          sessionTitle={sessionTitle}
        />
      ) : null}
    </aside>
  );
};
