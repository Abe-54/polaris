/**
 * The send's answer (DESIGN.md, Requests → Send pane): "200 OK · 840 ms", then Body (JSON pretty)
 * and Headers tabs. A send with no response says what happened instead.
 */
import type { Send } from "@polaris/protocol";
import { cn } from "@polaris/ui";
import { type ReactNode, useState } from "react";
import { durationLabel } from "../../../traces/model/waterfall/index.ts";
import { responseBody, statusLine } from "./model.ts";

export const StatusLine = ({
  send,
  after,
}: {
  readonly send: Send;
  readonly after?: ReactNode;
}) => (
  <div className="px-panel flex items-baseline gap-2 pt-3.5 pb-2.5" data-testid="send-status">
    <span
      className={cn(
        "text-heading-sm shrink-0 font-mono font-semibold whitespace-nowrap",
        send.outcome === "ok" ? "text-text-strong" : "text-severity-critical-text"
      )}
    >
      {statusLine(send)}
    </span>
    <span className="text-caption text-text-subtle shrink-0 font-mono whitespace-nowrap">
      {`· ${durationLabel(send.durationMs)}`}
    </span>
    {after}
  </div>
);

type ResponseTab = "body" | "headers";

const Tab = ({
  selected,
  label,
  note,
  onSelect,
}: {
  readonly selected: boolean;
  readonly label: string;
  readonly note: string | null;
  readonly onSelect: () => void;
}) => (
  <button
    type="button"
    role="tab"
    aria-selected={selected}
    onClick={onSelect}
    data-testid={`send-tab-${label.toLowerCase()}`}
    className={cn(
      "focus-visible:ring-starlight flex h-full cursor-default items-center gap-1.5 border-b outline-none focus-visible:ring-2",
      selected ? "border-text-strong" : "border-transparent"
    )}
  >
    <span
      className={cn("text-body", selected ? "text-text-strong font-medium" : "text-text-subtle")}
    >
      {label}
    </span>
    {note === null ? null : (
      <span
        className={cn("text-micro font-mono", selected ? "text-text-subtle" : "text-text-faint")}
      >
        {note}
      </span>
    )}
  </button>
);

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

const Body = ({ send }: { readonly send: Send }) => {
  const body = responseBody(send);

  if (body === null)
    return (
      <p className="text-caption text-text-faint px-panel py-2" data-testid="send-body-empty">
        {send.status === undefined ? (send.errorMessage ?? "No response") : "No body"}
      </p>
    );

  return (
    <>
      <pre
        className="text-code-inline text-text-default px-panel py-2 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap"
        data-testid="send-body"
      >
        {body.text}
      </pre>
      {send.responseTruncated ? (
        <p className="text-caption text-text-faint px-panel pb-2">
          {send.responseBytes === undefined
            ? "Cut at 1 MB"
            : `Cut at 1 MB of ${kb(send.responseBytes)}`}
        </p>
      ) : null}
    </>
  );
};

const Headers = ({ send }: { readonly send: Send }) => (
  <dl className="px-panel py-2" data-testid="send-headers">
    {send.responseHeaders.map((h, i) => (
      <div key={`${h.name}:${i}`} className="flex gap-2.5 py-[2px]">
        <dt className="text-code-inline text-text-subtle w-[140px] shrink-0 truncate font-mono">
          {h.name}
        </dt>
        <dd className="text-code-inline text-text-default min-w-0 font-mono [overflow-wrap:anywhere]">
          {h.value}
        </dd>
      </div>
    ))}
  </dl>
);

export const ResponseView = ({ send }: { readonly send: Send }) => {
  const [tab, setTab] = useState<ResponseTab>("body");
  const body = responseBody(send);

  return (
    <>
      <div
        role="tablist"
        aria-label="Response"
        className="border-hairline px-panel flex h-[34px] shrink-0 items-center gap-[18px] border-b"
      >
        <Tab
          selected={tab === "body"}
          label="Body"
          note={body === null ? null : body.json ? "json" : null}
          onSelect={() => setTab("body")}
        />
        <Tab
          selected={tab === "headers"}
          label="Headers"
          note={String(send.responseHeaders.length)}
          onSelect={() => setTab("headers")}
        />
      </div>
      <div role="tabpanel" className="max-h-[320px] min-h-[64px] shrink-0 overflow-y-auto">
        {tab === "body" ? <Body send={send} /> : <Headers send={send} />}
      </div>
    </>
  );
};
