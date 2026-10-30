import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "../../../lib/cn";
import { SettingsButton } from "./button";
import { ROW_PAD } from "./tones";

/** Cancel's Starlight ring on any focus, since a click that opens the confirm isn't keyboard focus. */
const HELD_FOCUS =
  "focus:outline-starlight focus:outline-2 focus:outline-offset-2 focus:outline-solid";

export interface SettingsConfirmRowProps {
  readonly title: ReactNode;
  /** Leads the row in both states, e.g. a host's colour square. */
  readonly leading?: ReactNode;
  /** The caption while nothing is asked. */
  readonly caption?: ReactNode;
  /** The row's button that asks ("Revoke"). */
  readonly action: string;
  /**
   * How that button looks before it asks: `danger` (the default, "Remove workspace…"), or
   * `secondary` where the row is routine until confirmed ("Revoke", "Unlink"; SR-07, SR-08).
   */
  readonly actionVariant?: "danger" | "secondary";
  /** The caption while it asks: what goes ("Revoking disconnects it now…"). */
  readonly consequence: ReactNode;
  /** The confirming button, naming its object ("Revoke Even G2"). */
  readonly confirm: string;
  readonly onConfirm: () => void;
  /** Disables the action, with the reason as its caption ("2 agent sessions remain"). */
  readonly disabledReason?: string;
  /** Other row actions beside the danger button ("Unhide"). */
  readonly children?: ReactNode;
}

/**
 * A destructive action confirmed in place, never a modal (SR-Kit 05): the row takes a faint
 * failed tint, its caption becomes the consequence, Cancel holds focus, esc cancels.
 */
export function SettingsConfirmRow({
  title,
  leading,
  caption,
  action,
  actionVariant = "danger",
  consequence,
  confirm,
  onConfirm,
  disabledReason,
  children,
}: SettingsConfirmRowProps) {
  const [asking, setAsking] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (asking) cancel.current?.focus();
    else if (returnFocus.current) trigger.current?.focus();
  }, [asking]);

  const stop = () => {
    returnFocus.current = true;
    setAsking(false);
  };

  if (!asking)
    return (
      <div data-slot="settings-confirm-row" className={cn("flex items-center gap-3", ROW_PAD)}>
        {leading}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-body text-text-default truncate">{title}</span>
          {(disabledReason ?? caption) === undefined ? null : (
            <span className="text-caption text-text-subtle truncate">
              {disabledReason ?? caption}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {children}
          <SettingsButton
            ref={trigger}
            variant={actionVariant}
            disabled={disabledReason !== undefined}
            onClick={() => setAsking(true)}
          >
            {action}
          </SettingsButton>
        </div>
      </div>
    );

  return (
    <div
      data-slot="settings-confirm-row"
      data-asking=""
      role="group"
      aria-label={confirm}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        stop();
      }}
      className={cn("bg-failed-text/4 flex items-center gap-3", ROW_PAD)}
    >
      {leading}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body text-text-default">{title}</span>
        <span className="text-caption text-text-default">{consequence}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SettingsButton ref={cancel} variant="ghost" className={HELD_FOCUS} onClick={stop}>
          Cancel
        </SettingsButton>
        <SettingsButton
          variant="danger"
          onClick={() => {
            returnFocus.current = false;
            setAsking(false);
            onConfirm();
          }}
        >
          {confirm}
        </SettingsButton>
      </div>
    </div>
  );
}
