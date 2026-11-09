/**
 * The send pane (DESIGN.md, Requests → Send pane; Paper Q1–Q3): status and duration, who sent it
 * and when, the response, then TRACE (the send's trace, live) and DATA (the tables it touched).
 */
import type { Send } from "@polaris/protocol";
import { commandShortcut } from "../../../../../shared/keymap.ts";
import { useApp } from "../../../../shell/hooks.ts";
import type { RequestsSessionKey } from "../../model/session.ts";
import type { SendPaneProps } from "../slots.ts";
import { AdHocActions, useSendAgain } from "./AdHocActions.tsx";
import { DataSection } from "./DataSection.tsx";
import { isAdHocAgentSend } from "./model.ts";
import { ResponseView, StatusLine } from "./Response.tsx";
import { SendFailureSlot } from "./states.tsx";
import { TraceSection } from "./TraceSection.tsx";
import { useOpenElsewhere } from "./useOpenElsewhere.ts";
import { useSendTrace } from "./useSendTrace.ts";

const pad = (n: number) => n.toString().padStart(2, "0");

const clock = (iso: string) => {
  const at = new Date(iso);

  return Number.isNaN(at.getTime())
    ? ""
    : `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};

/** "you", or the agent session that sent it. */
const useAuthor = (at: RequestsSessionKey, send: Send) =>
  useApp((s) => {
    if (send.by.kind === "user") return "you";
    const title = s.hostModels[at.hostKey]?.sessions.get(send.by.sessionId)?.session.title;

    return title === undefined || title === "" ? "an agent" : title;
  });

const Sent = ({ at, send }: { readonly at: RequestsSessionKey; readonly send: Send }) => {
  const author = useAuthor(at, send);
  const when = clock(send.startedAt);
  const adHoc = isAdHocAgentSend(send);

  return (
    <StatusLine
      send={send}
      after={
        <>
          {adHoc ? (
            <span
              className="text-caption text-text-faint shrink-0 whitespace-nowrap"
              data-testid="send-not-saved"
            >
              not saved
            </span>
          ) : null}
          <span className="min-w-2 flex-1" />
          <span
            className="text-caption text-text-subtle flex min-w-0 shrink font-mono whitespace-nowrap"
            data-testid="send-by"
            title={author}
          >
            <span className="min-w-0 truncate">{author}</span>
            {when === "" ? null : <span className="shrink-0">{` · ${when}`}</span>}
          </span>
        </>
      }
    />
  );
};

const Traced = ({ at, traceId }: { readonly at: RequestsSessionKey; readonly traceId: string }) => {
  const trace = useSendTrace(at, traceId);
  const open = useOpenElsewhere(at);

  return (
    <>
      <TraceSection
        at={at}
        traceId={traceId}
        trace={trace}
        onOpen={(spanId) => open.trace(traceId, spanId)}
      />
      {trace.status === "ready" ? <DataSection at={at} detail={trace.value} /> : null}
    </>
  );
};

const Answer = ({
  at,
  send,
  sending,
}: {
  readonly at: RequestsSessionKey;
  readonly send: Send;
  readonly sending: boolean;
}) => {
  const sendAgain = useSendAgain(at, send);
  const answered = send.outcome === "ok" || send.outcome === "http-error";

  return (
    <>
      <Sent at={at} send={send} />
      {isAdHocAgentSend(send) ? <AdHocActions at={at} send={send} sending={sending} /> : null}
      {answered ? (
        <ResponseView send={send} />
      ) : (
        <SendFailureSlot send={send} onSendAgain={() => void sendAgain()} />
      )}
      {send.traceId === null ? null : <Traced key={send.traceId} at={at} traceId={send.traceId} />}
    </>
  );
};

export const SendPane = ({ at, latest, sending }: SendPaneProps) => (
  <section
    aria-label="Response"
    aria-busy={sending}
    className="flex w-[500px] max-w-[45%] shrink-0 flex-col overflow-y-auto"
    data-testid="requests-send-pane"
  >
    {latest === null ? (
      <p className="text-caption text-text-subtle px-panel pt-4">
        {sending ? "Sending…" : `Send it with ${commandShortcut("requests.send")}`}
      </p>
    ) : (
      <Answer key={latest.id} at={at} send={latest} sending={sending} />
    )}
  </section>
);
