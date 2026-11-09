/**
 * A checkout with no `.http` files (DESIGN.md, Requests → States; Paper Q3): asking an agent to
 * write Requests for the app's routes comes first, then a new Request in http/requests.http and a
 * pasted curl command. Asking hands the task to the shown agent session, as Traces' setup does.
 */
import { cn, Kbd } from "@polaris/ui";
import { useState } from "react";
import { shortcutLabel } from "../../../../../shared/chord.ts";
import { commandShortcut } from "../../../../../shared/keymap.ts";
import { useApp } from "../../../../shell/hooks.ts";
import { placementOf } from "../../../traces/model/agentSetup.ts";
import { type Asked, askAgent } from "../../../traces/ui/setup/actions.ts";
import { NEW_REQUEST_FILE } from "../../model/draft.ts";
import { WRITE_REQUESTS_PROMPT } from "../../model/states.ts";
import type { RequestsSlotProps } from "../slots.ts";

const askedLine = (asked: Asked | null): string | null => {
  if (asked === null) return null;

  switch (asked.kind) {
    case "steered":
    case "sent":
      return "Asked this agent session. Its requests show here as it saves them.";
    case "started":
      return "A new agent session is writing requests for this checkout.";
    case "waiting":
      return "The agent session is still starting; ask again once it's ready.";
    case "refused":
      return null;
  }
};

const Action = ({
  first,
  onClick,
  hint,
  children,
  testId,
  disabled = false,
}: {
  readonly first?: boolean;
  readonly onClick: () => void;
  readonly hint: string;
  readonly children: React.ReactNode;
  readonly testId: string;
  readonly disabled?: boolean;
}) => (
  <button
    type="button"
    data-testid={testId}
    // The first action is the default: ↵ runs it, as its hint says.
    autoFocus={first === true}
    disabled={disabled}
    onClick={onClick}
    className={cn(
      "text-body text-text-default hover:bg-fill-hover focus-visible:ring-starlight flex h-9 w-full cursor-default items-center gap-2 rounded-[10px] px-2.5 text-left outline-none focus-visible:ring-2 disabled:opacity-(--opacity-dimmed)",
      first === true && "bg-fill-selected text-text-strong"
    )}
  >
    <span className="min-w-0 flex-1 truncate">{children}</span>
    {hint === "" ? null : <Kbd variant="plain">{hint}</Kbd>}
  </button>
);

export interface EmptyCheckoutProps extends RequestsSlotProps {
  readonly onNew: () => void;
  readonly onPasteCurl: () => void;
}

export const EmptyCheckout = ({ at, workspaceId, onNew, onPasteCurl }: EmptyCheckoutProps) => {
  const model = useApp((s) => s.hostModels[at.hostKey]);
  const session = model?.sessions.get(at.sessionId)?.session ?? null;
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState<Asked | null>(null);
  const line = askedLine(asked);

  const ask = async () => {
    if (session === null) return;
    setAsking(true);

    const place = {
      hostKey: at.hostKey,
      workspaceId,
      session,
      placement: placementOf(session, model?.reviewCheckouts.values() ?? []),
    };

    setAsked(await askAgent(place, WRITE_REQUESTS_PROMPT));
    setAsking(false);
  };

  return (
    <section
      aria-label="No requests in this checkout yet"
      data-testid="requests-empty-checkout"
      className="rounded-card border-hairline bg-surface-raised flex w-full max-w-[520px] flex-col gap-4 border p-5"
    >
      <div className="flex flex-col gap-1.5">
        <h2 className="text-heading text-text-strong font-medium">
          No requests in this checkout yet
        </h2>
        <p className="text-body text-text-subtle">
          Requests live in .http files you commit with the code. Every send gets a trace, and the
          tables it touched open in Data.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Action
          first
          testId="requests-ask-agent"
          hint="↵"
          disabled={session === null || asking}
          onClick={() => void ask()}
        >
          Ask an agent to write requests for this app’s routes
        </Action>
        <Action testId="requests-empty-new" hint={commandShortcut("requests.new")} onClick={onNew}>
          New request{" "}
          <span className="text-text-subtle font-mono text-[12px]">in {NEW_REQUEST_FILE}</span>
        </Action>
        <Action
          testId="requests-empty-curl"
          hint={shortcutLabel("CmdOrCtrl+V")}
          onClick={onPasteCurl}
        >
          Paste a curl command
        </Action>
      </div>
      {line === null ? null : (
        <p role="status" className="text-caption text-text-subtle">
          {line}
        </p>
      )}
      <p className="text-caption text-text-subtle">
        Agents can already send without files: their sends show in the send log.
      </p>
    </section>
  );
};
