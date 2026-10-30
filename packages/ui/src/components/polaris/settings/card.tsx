import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../../../lib/cn";
import { Kicker } from "../instrument-card";

export interface SettingsWellProps extends HTMLAttributes<HTMLDivElement> {
  /** Rows with hairline dividers (the default), or free content such as instruments. */
  readonly rows?: boolean;
}

/** An inset well of rows inside a card. */
export function SettingsWell({ rows = true, className, ...props }: SettingsWellProps) {
  return (
    <div
      data-slot="settings-well"
      className={cn(
        "border-hairline bg-well flex flex-col overflow-hidden rounded-[12px] border",
        rows && "divide-hairline divide-y",
        className
      )}
      {...props}
    />
  );
}

export interface SettingsCardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly title: ReactNode;
  /** One aside: a summary ("4 of 5 on") or one control. */
  readonly aside?: ReactNode;
  /** The footer's mono status line. */
  readonly status?: ReactNode;
  /** At most one footer action, a SettingsButton. */
  readonly action?: ReactNode;
  /** The wells (SettingsWell), one or two. */
  readonly children: ReactNode;
}

/** HS-D's instrument card: a header, inset wells and a footer (SR-Kit 02). */
export function SettingsCard({
  title,
  aside,
  status,
  action,
  className,
  children,
  ...props
}: SettingsCardProps) {
  const footer = status !== undefined || action !== undefined;

  return (
    <section
      data-slot="settings-card"
      data-surface="raised"
      className={cn(
        "bg-raised px-gap gap-gap flex min-w-0 flex-col rounded-[16px] shadow-[inset_0_0_0_1px_var(--color-hairline)]",
        !footer && "pb-gap",
        className
      )}
      {...props}
    >
      <header className="px-gap flex min-h-5 items-center justify-between gap-3 pt-[calc(var(--spacing-panel)-2px)] pb-1">
        <h2 className="text-heading-sm text-text-strong min-w-0 truncate">{title}</h2>
        {aside === undefined ? null : (
          <div className="text-caption text-text-subtle flex shrink-0 items-center">{aside}</div>
        )}
      </header>
      {children}
      {footer ? (
        <footer className="pl-gap mt-auto flex min-h-10 items-center justify-between gap-3">
          <Kicker className="min-w-0 truncate font-normal tracking-[0.06em]">{status}</Kicker>
          {action}
        </footer>
      ) : null}
    </section>
  );
}
