/**
 * A Send with no response (DESIGN.md, Requests → States; Paper Q3): connection refused, timed out,
 * failed or denied. It names the address and the Host, shows what was sent, and offers "Send again"
 * and "Open a terminal". The send pane renders it in place of the response.
 */
import type { Send } from "@polaris/protocol";
import { Button } from "@polaris/ui";
import type { ReactNode } from "react";
import { useApp } from "../../../../shell/hooks.ts";
import { ApprovalWell } from "../../../data/approval/ApprovalAnatomy.tsx";
import { openTerminalIn } from "../../../terminal/index.ts";
import { clockTime, sentBy } from "../../model/sendLog.ts";
import {
  type FailedOutcome,
  failureCode,
  failureTitle,
  type SendSource,
  sendAddress,
} from "../../model/states.ts";
import type { RequestsSlotProps } from "../slots.ts";

const Code = ({ children }: { readonly children: string }) => (
  <code className="text-code-inline text-text-default font-mono">{children}</code>
);

/** "or check {{base}} in env dev": only when the Request's URL starts with a variable. */
const CheckSource = ({ source }: { readonly source: SendSource }) =>
  source.variable === null ? (
    <> Start the server, or check the URL.</>
  ) : (
    <>
      {" Start the dev server, or check "}
      <code className="text-code-inline text-starlight font-mono">{`{{${source.variable}}}`}</code>
      {source.environment === null ? "." : ` in env ${source.environment}.`}
    </>
  );

const explanation = (
  send: Send & { readonly outcome: FailedOutcome },
  host: string,
  source: SendSource
): ReactNode => {
  const address = <Code>{sendAddress(send.url)}</Code>;

  switch (send.outcome) {
    case "refused":
      return (
        <>
          {"Nothing is listening on "}
          {address}
          {` on ${host}.`}
          <CheckSource source={source} />
        </>
      );
    case "timeout":
      return (
        <>
          {address}
          {` didn’t answer ${host} within ${Math.round(send.durationMs / 1000)} s. The server may be stuck on this request; its trace may say where.`}
        </>
      );
    case "denied":
      return `Agents can’t send to this origin: its Origin Approval was denied on ${host}. Sends you make yourself never need one.`;
    case "failed":
      return send.errorMessage ?? `The send failed on ${host} before any response came.`;
  }
};

export interface SendFailureProps extends RequestsSlotProps {
  readonly send: Send & { readonly outcome: FailedOutcome };
  /** Where the URL's origin came from, when the open Request says. */
  readonly source: SendSource;
  /** Sends the open Request again, as ⌘↵ does. */
  readonly onSendAgain: () => void;
}

export const SendFailure = ({ at, workspaceId, send, source, onSendAgain }: SendFailureProps) => {
  const host = useApp((s) => s.hosts.find((h) => h.key === at.hostKey)?.label ?? "this host");
  const sessions = useApp((s) => s.hostModels[at.hostKey]?.sessions);
  const by = sentBy(send, (id) => sessions?.get(id)?.session.title ?? null);
  const code = failureCode(send.outcome);

  return (
    <section
      className="rounded-card border-hairline bg-surface-raised flex flex-col gap-3 border p-4"
      data-testid="requests-send-failure"
      data-outcome={send.outcome}
      aria-label={failureTitle(send.outcome)}
    >
      <div className="flex items-baseline gap-2">
        <h3 className="text-heading-sm text-severity-critical-text min-w-0 flex-1 font-mono font-medium">
          {failureTitle(send.outcome)}
        </h3>
        <span className="text-caption text-text-subtle shrink-0">{`${by} · ${clockTime(send.startedAt)}`}</span>
      </div>
      <p className="text-body text-text-subtle [overflow-wrap:anywhere]">
        {explanation(send, host, source)}
      </p>
      <ApprovalWell
        className="mx-0"
        testId="requests-send-failure-sent"
        rows={[
          ["Sent", `${send.method} ${send.url}`],
          ["From", code === null ? host : `${host} · ${code}`],
        ]}
      />
      <div className="flex items-center gap-1">
        <Button variant="secondary" className="rounded-full" onClick={onSendAgain}>
          Send again
        </Button>
        {send.outcome === "denied" ? null : (
          <Button
            variant="ghost"
            className="rounded-full"
            onClick={() => void openTerminalIn({ hostKey: at.hostKey, workspaceId }, send.checkout)}
          >
            Open a terminal
          </Button>
        )}
      </div>
    </section>
  );
};
