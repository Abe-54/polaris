/**
 * The empty state's primary block (Paper T4, left): "Set up tracing with an agent" installs the
 * polaris-tracing skill on the Host and starts an agent session; Node instrumentation is a setting.
 */
import {
  type AgentSession,
  harnessEntry,
  type SessionId,
  type SessionPlacement,
} from "@polaris/protocol";
import { Button } from "@polaris/ui";
import { useState } from "react";
import { useShellActions } from "../../../../shell/hooks.ts";
import { installCommand } from "../../model/agentSetup.ts";
import { type SetupProgress, setUpTracing } from "./actions.ts";
import { Copyable } from "./parts.tsx";

const progressLine = (progress: SetupProgress): string | null => {
  switch (progress.kind) {
    case "idle":
      return null;
    case "installing":
      return "Installing the skill in this workspace’s terminal…";
    case "starting":
      return "Installed. Starting the agent session…";
    case "started":
      return "An agent session is setting up tracing in this checkout.";
    case "failed":
      return progress.message;
  }
};

const Started = ({ hostKey, sessionId }: { hostKey: string; sessionId: SessionId }) => {
  const { selectSession } = useShellActions();

  return (
    <Button variant="ghost" size="xs" onClick={() => selectSession({ hostKey, sessionId })}>
      Open agent session
    </Button>
  );
};

export const SetUpWithAgent = ({
  hostKey,
  workspaceId,
  session,
  placement,
  onInstrument,
}: {
  readonly hostKey: string;
  readonly workspaceId: string;
  /** Null while the session's feed hasn't arrived; the button waits for it. */
  readonly session: AgentSession | null;
  readonly placement: SessionPlacement | null;
  /** Opens Settings → Traces for this Workspace; null on Daemons without `traces.settings`. */
  readonly onInstrument: (() => void) | null;
}) => {
  const [progress, setProgress] = useState<SetupProgress>({ kind: "idle" });
  const busy = progress.kind === "installing" || progress.kind === "starting";
  const line = progressLine(progress);
  const harness = session === null ? undefined : harnessEntry(session.harness)?.name;

  return (
    <section
      className="border-hairline bg-surface-sunken rounded-card flex flex-col gap-3 border p-4"
      data-testid="traces-setup-agent"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-label text-text-strong font-medium">Set up tracing with an agent</h3>
        <span className="text-code-inline text-text-faint font-mono">polaris-tracing skill</span>
      </div>
      <p className="text-caption text-text-subtle">
        Installs the skill for {harness ?? "Claude Code and Codex"} on this host, then starts{" "}
        {harness === undefined ? "an agent session" : `a ${harness} session`} that adds
        OpenTelemetry here, reading the endpoint from the environment.
      </p>
      <Copyable text={installCommand(session?.harness ?? null)} label="Copy" />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={busy || session === null || placement === null}
          onClick={() => {
            if (session !== null && placement !== null)
              void setUpTracing({ hostKey, workspaceId, session, placement }, setProgress);
          }}
        >
          {progress.kind === "failed" ? "Try again" : "Set up tracing"}
        </Button>
        {onInstrument === null ? null : (
          <Button variant="ghost" className="border-hairline border" onClick={onInstrument}>
            Instrument Node automatically
          </Button>
        )}
      </div>
      {line === null ? null : (
        <div className="flex items-center gap-2" role="status" data-testid="traces-setup-progress">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <p className="text-caption text-text-subtle">{line}</p>
            {progress.kind !== "failed" || progress.output.length === 0 ? null : (
              <pre
                className="text-code-inline text-text-default bg-surface-raised border-hairline rounded-control overflow-x-auto border px-2 py-1.5 font-mono whitespace-pre-wrap"
                data-testid="traces-setup-output"
              >
                {progress.output.join("\n")}
              </pre>
            )}
          </div>
          {progress.kind === "started" ? (
            <Started hostKey={hostKey} sessionId={progress.sessionId} />
          ) : null}
        </div>
      )}
    </section>
  );
};
