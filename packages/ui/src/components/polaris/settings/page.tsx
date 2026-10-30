import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

import { cn } from "../../../lib/cn";
import { FAINT_FILL } from "./tones";

/** 22/28 Semibold, scaled with text size as the type roles are. */
const TITLE: CSSProperties = {
  fontSize: "round(calc(22px * var(--text-scale, 1)), 1px)",
  lineHeight: "round(calc(28px * var(--text-scale, 1)), 1px)",
};

export interface SettingsScopeProps extends HTMLAttributes<HTMLSpanElement> {
  /** A 12px glyph before the words (a screen for "This Mac"). */
  readonly icon?: ReactNode;
}

/** Where the page's settings live: "This Mac", "Each host", "Saved on each host". */
export function SettingsScope({ icon, className, children, ...props }: SettingsScopeProps) {
  return (
    <span
      data-slot="settings-scope"
      className={cn(
        "border-hairline text-caption text-text-default flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 whitespace-nowrap [&_svg]:text-text-subtle",
        FAINT_FILL,
        className
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  );
}

export interface SettingsPageProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  readonly title: string;
  /** One line in text-subtle; scope goes in the pill, not here. */
  readonly blurb: string;
  readonly scope?: ReactNode;
  /** A glyph for the scope pill. */
  readonly scopeIcon?: ReactNode;
}

/** A page: its header, then its cards in an ~860px column, 8px apart at Calm. */
export function SettingsPage({
  title,
  blurb,
  scope,
  scopeIcon,
  className,
  children,
  ...props
}: SettingsPageProps) {
  return (
    <div
      data-slot="settings-page"
      className={cn(
        "gap-gap mx-auto flex w-[860px] max-w-[calc(100%-2rem)] flex-col py-[calc(var(--spacing-section)+16px)]",
        className
      )}
      {...props}
    >
      <header className="gap-panel flex items-end pb-[calc(var(--spacing-section)-4px)]">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-text-strong font-[600] tracking-[-0.01em]" style={TITLE}>
            {title}
          </h1>
          <p className="text-body text-text-subtle truncate">{blurb}</p>
        </div>
        {scope === undefined ? null : <SettingsScope icon={scopeIcon}>{scope}</SettingsScope>}
      </header>
      {children}
    </div>
  );
}

/** Two cards side by side once their column has ~760px, as tall as each other; one column below that. */
export function SettingsGrid({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div data-slot="settings-grid" className="@container" {...props}>
      <div className={cn("gap-gap grid @[47.5rem]:grid-cols-2", className)}>{children}</div>
    </div>
  );
}
