/**
 * A host page's header (Paper HS-D): the breadcrumb, the colour square, the name in 22px
 * Semibold, its mono line, the Connection State pill, Retry now when it applies, and the ⋯
 * menu. Remove host confirms in the header's place, never in a modal.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SettingsButton,
} from "@polaris/ui";
import type { CSSProperties } from "react";
import type { MachineView } from "../../../../shared/api.ts";
import { clientCopy } from "../../../../shared/clientCopy.ts";
import { ChevronGlyph, ColourSquare, ConnectionPill, DotsGlyph } from "./parts.tsx";
import { hostName, type Pill } from "./state.ts";

/** The kit's page title: 22/28 Semibold, scaled with text size. */
const TITLE: CSSProperties = {
  fontSize: "round(calc(22px * var(--text-scale, 1)), 1px)",
  lineHeight: "round(calc(28px * var(--text-scale, 1)), 1px)",
};

export const Breadcrumb = ({
  label,
  onBack,
}: {
  readonly label: string;
  readonly onBack: () => void;
}) => (
  <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
    <button
      type="button"
      onClick={onBack}
      className="text-body text-text-subtle hover:text-text-default flex cursor-default items-center gap-1.5"
    >
      <ChevronGlyph back />
      Hosts
    </button>
    <span className="text-body text-text-faint">/</span>
    <span className="text-body text-text-default truncate" aria-current="page">
      {label}
    </span>
  </nav>
);

export interface HeaderProps {
  readonly machine: MachineView;
  readonly line: string;
  readonly pill: Pill;
  readonly onRetry: () => void;
  readonly onRestart: (() => void) | null;
  readonly onUpgrade: (() => void) | null;
  /** "0.5.0 is current" when there is nothing to upgrade to. */
  readonly upgradeNote: string;
  readonly onRename: () => void;
  /** Null for this Mac: it has "Use this Mac as a host" instead. */
  readonly onRemove: (() => void) | null;
}

const Menu = ({
  machine,
  pill,
  onRetry,
  onRestart,
  onUpgrade,
  upgradeNote,
  onRename,
  onRemove,
}: HeaderProps) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      aria-label={`${machine.label} actions`}
      className="hover:bg-fill-hover flex size-[30px] shrink-0 cursor-default items-center justify-center rounded-full bg-[light-dark(#00000005,#ffffff0a)]"
    >
      <DotsGlyph />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-[220px]">
      {pill.retry ? <DropdownMenuItem onSelect={onRetry}>Retry now</DropdownMenuItem> : null}
      <DropdownMenuItem needsInput onSelect={() => onRestart?.()} disabled={onRestart === null}>
        Restart daemon…
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onUpgrade?.()} disabled={onUpgrade === null}>
        Upgrade daemon
        {onUpgrade === null ? (
          <span className="text-caption text-text-subtle ml-auto pl-3">{upgradeNote}</span>
        ) : null}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="font-mono text-[10px] tracking-[0.06em]">
        HOST
      </DropdownMenuLabel>
      <DropdownMenuItem needsInput onSelect={onRename}>
        Rename…
      </DropdownMenuItem>
      {onRemove === null ? null : (
        <DropdownMenuItem needsInput onSelect={onRemove} className="text-failed-text">
          Remove host…
        </DropdownMenuItem>
      )}
    </DropdownMenuContent>
  </DropdownMenu>
);

export const Header = (props: HeaderProps) => {
  const { machine, line, pill, onRetry } = props;

  return (
    <div className="flex items-center gap-3.5" data-testid="host-header">
      <ColourSquare colour={machine.colour} size={14} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h1 className="text-text-strong truncate font-[600] tracking-[-0.01em]" style={TITLE}>
          {hostName(machine)}
        </h1>
        <span className="text-text-subtle truncate font-mono text-[11px] leading-4">{line}</span>
      </div>
      <ConnectionPill pill={pill} />
      {pill.retry ? <SettingsButton onClick={onRetry}>Retry now</SettingsButton> : null}
      <Menu {...props} />
    </div>
  );
};

/** Remove host, asked in the header's place: what goes, Cancel (focused) and Remove host. */
export const RemoveConfirm = ({
  label,
  onCancel,
  onRemove,
}: {
  readonly label: string;
  readonly onCancel: () => void;
  readonly onRemove: () => void;
}) => (
  <div
    role="alertdialog"
    aria-label={`Remove ${label}?`}
    data-testid="remove-confirm"
    className="flex items-center gap-3.5 rounded-[12px] bg-[light-dark(#d23b300a,#f0645a0f)] px-4 py-3"
  >
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-body text-text-strong font-medium">Remove {label}?</span>
      <span className="text-caption text-text-subtle">
        Its entry and saved settings on {clientCopy().machine} go. Its daemon and agent sessions
        stay on {label}.
      </span>
    </div>
    <SettingsButton variant="ghost" autoFocus onClick={onCancel}>
      Cancel
    </SettingsButton>
    <SettingsButton variant="danger" onClick={onRemove}>
      Remove host
    </SettingsButton>
  </div>
);
