import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "../../../lib/cn";
import { CONTROL_EDGE, SOFT_FILL } from "./tones";

/**
 * Settings' 28px pill (rule/buttons-where-you-click): anything the user is expected to click
 * is one of these, never coloured or quiet text, except `quiet` beside a more important action.
 */
export const settingsButtonVariants = cva(
  "inline-flex h-7 shrink-0 cursor-default items-center justify-center gap-1.5 rounded-full px-3 text-caption font-medium whitespace-nowrap select-none transition-transform duration-120 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-(--opacity-dimmed)",
  {
    variants: {
      variant: {
        /** The page's one primary ("Add account"); a card never holds it. */
        primary: "bg-text-default text-[color:light-dark(#ffffff,var(--color-surface-sunken))]",
        /** A card footer's action, a link to another page ("Check now", "Hosts…"). */
        secondary: cn(SOFT_FILL, "text-text-default hover:bg-fill-hover"),
        /** A row action that must still read as a button ("Unhide", "Cancel"). */
        ghost: cn("border", CONTROL_EDGE, "text-text-default hover:bg-fill-hover"),
        /** Names its object ("Revoke Even G2"). */
        danger: "bg-fill-selected text-failed-text hover:bg-fill-hover",
        /** Only a secondary action beside a more important one (Reset under a list). */
        quiet: "text-text-subtle hover:text-text-default",
      },
    },
    defaultVariants: { variant: "secondary" },
  }
);

export type SettingsButtonProps = ComponentProps<"button"> &
  VariantProps<typeof settingsButtonVariants>;

export function SettingsButton({
  variant = "secondary",
  className,
  type = "button",
  ...props
}: SettingsButtonProps) {
  return (
    <button
      data-slot="settings-button"
      data-variant={variant}
      type={type}
      className={cn(settingsButtonVariants({ variant }), className)}
      {...props}
    />
  );
}
