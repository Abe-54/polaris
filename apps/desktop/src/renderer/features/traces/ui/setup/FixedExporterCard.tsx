/**
 * The fixed-exporter card (DESIGN.md, Traces → Setup; Paper T4, middle): exporters whose URL is in
 * code, each at file:line with its runtime, the one-line change, and "Ask an agent to make this change".
 */
import type { AgentSession, DetectedTraceExporter } from "@polaris/protocol";
import { Button } from "@polaris/ui";
import { useState } from "react";
import { useShellActions } from "../../../../shell/hooks.ts";
import { fixedExporterPrompt } from "../../model/agentSetup.ts";
import { FIXED_EXPORTER_CHANGE } from "../../model/setup.ts";
import { exporterLocation, fixedExporterLead, fixedExporterTitle } from "../../settings/model.ts";
import { type Asked, askAgent } from "./actions.ts";
import { Copyable, Lead } from "./parts.tsx";

const ASKED: Readonly<Record<Asked["kind"], string>> = {
  steered: "Sent to this agent session while it works.",
  sent: "Sent to this agent session as its next turn.",
  started: "An agent session is making the change in this checkout.",
  refused: "The agent session didn’t take it; the reason is in the toast.",
};

const Exporters = ({ exporters }: { readonly exporters: ReadonlyArray<DetectedTraceExporter> }) => (
  <ul className="border-hairline bg-surface-sunken rounded-control divide-hairline flex flex-col divide-y border">
    {exporters.map((e) => (
      <li key={exporterLocation(e)} className="flex h-[34px] items-center gap-3 px-3">
        <code className="text-code-inline text-text-default min-w-0 flex-1 truncate font-mono">
          {exporterLocation(e)}
        </code>
        <span className="text-code-inline text-text-faint w-10 shrink-0 text-right font-mono">
          {e.runtime ?? ""}
        </span>
      </li>
    ))}
  </ul>
);

export const FixedExporterCard = ({
  hostKey,
  workspaceId,
  workspaceName,
  session,
  exporters,
  forwarding,
  onSettings,
  onDismiss,
}: {
  readonly hostKey: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly session: AgentSession | null;
  readonly exporters: ReadonlyArray<DetectedTraceExporter>;
  readonly forwarding: boolean;
  /** Opens Settings → Traces for this Workspace, where forwarding is set. */
  readonly onSettings: () => void;
  readonly onDismiss: () => void;
}) => {
  const { selectSession } = useShellActions();
  const [asked, setAsked] = useState<Asked | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    if (session === null) return;
    setBusy(true);
    setAsked(await askAgent({ hostKey, workspaceId, session }, fixedExporterPrompt(exporters)));
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="traces-fixed-exporter">
      <Lead title={fixedExporterTitle(workspaceName, exporters)}>
        <p>{fixedExporterLead(exporters, forwarding)}</p>
      </Lead>
      <Exporters exporters={exporters} />
      <Copyable text={FIXED_EXPORTER_CHANGE} label="Copy" />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={busy || session === null} onClick={() => void ask()}>
          Ask an agent to make this change
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          Not now
        </Button>
        <Button variant="ghost" className="ml-auto" onClick={onSettings}>
          {forwarding ? "Forwarding settings" : "Turn on forwarding"}
        </Button>
      </div>
      {asked === null ? null : (
        <div className="flex items-center gap-2" role="status">
          <p className="text-caption text-text-subtle min-w-0 flex-1">{ASKED[asked.kind]}</p>
          {asked.kind === "started" ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => selectSession({ hostKey, sessionId: asked.sessionId })}
            >
              Open agent session
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
};
