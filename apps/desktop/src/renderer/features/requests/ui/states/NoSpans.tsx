/**
 * A Send whose server sent no Spans (DESIGN.md, Requests → States; Paper Q3): only Polaris's own
 * "send · polaris" span came back. "Ask an agent to add tracing" is Traces' setup hand-off: it
 * installs the polaris-tracing skill and starts an agent session in this checkout.
 */
import { Button, Kbd } from "@polaris/ui";
import { useState } from "react";
import { commandShortcut } from "../../../../../shared/keymap.ts";
import { useApp, useShellActions } from "../../../../shell/hooks.ts";
import { placementOf } from "../../../traces/model/agentSetup.ts";
import { type SetupProgress, setUpTracing } from "../../../traces/ui/setup/actions.ts";
import type { RequestsSlotProps } from "../slots.ts";

export const NO_SPANS_LINE =
  "The server sent no spans for this send. If it exports traces, they may still be on their way; if not, an agent can set it up.";

const progressLine = (progress: SetupProgress): string | null => {
  switch (progress.kind) {
    case "idle":
      return null;
    case "installing":
      return "Installing the polaris-tracing skill in this workspace’s terminal…";
    case "starting":
      return "Installed. Starting the agent session…";
    case "started":
      return "An agent session is adding tracing in this checkout.";
    case "failed":
      return progress.message;
  }
};

/** The shown session and where a new one beside it works, as Traces' setup takes them. */
const usePlace = ({ at, workspaceId }: RequestsSlotProps) => {
  const model = useApp((s) => s.hostModels[at.hostKey]);
  const session = model?.sessions.get(at.sessionId)?.session ?? null;

  return session === null
    ? null
    : {
        hostKey: at.hostKey,
        workspaceId,
        session,
        placement: placementOf(session, model?.reviewCheckouts.values() ?? []),
      };
};

export interface NoSpansProps extends RequestsSlotProps {
  /** "Open in Traces ⌘5" with the Send's trace; absent where the send pane offers it already. */
  readonly onOpenTraces?: () => void;
}

export const NoSpans = (props: NoSpansProps) => {
  const place = usePlace(props);
  const { selectSession } = useShellActions();
  const [progress, setProgress] = useState<SetupProgress>({ kind: "idle" });
  const busy = progress.kind === "installing" || progress.kind === "starting";
  const line = progressLine(progress);

  return (
    <div className="flex flex-col gap-3" data-testid="requests-no-spans">
      <p className="text-body text-text-subtle">{NO_SPANS_LINE}</p>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="secondary"
          className="rounded-full"
          disabled={place === null || busy}
          onClick={() => {
            if (place !== null) void setUpTracing(place, setProgress);
          }}
        >
          Ask an agent to add tracing
        </Button>
        {props.onOpenTraces === undefined ? null : (
          <Button variant="ghost" className="rounded-full" onClick={props.onOpenTraces}>
            Open in Traces <Kbd variant="plain">{commandShortcut("view.traces")}</Kbd>
          </Button>
        )}
      </div>
      {line === null ? null : (
        <p role="status" className="text-caption text-text-subtle">
          {line}
          {progress.kind === "started" ? (
            <Button
              variant="ghost"
              size="xs"
              className="ml-1"
              onClick={() =>
                selectSession({ hostKey: props.at.hostKey, sessionId: progress.sessionId })
              }
            >
              Open agent session
            </Button>
          ) : null}
        </p>
      )}
    </div>
  );
};
