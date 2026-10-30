import { Switch as SwitchPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../../lib/cn";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { CONTROL_EDGE, DASHED_EDGE } from "./tones";

/** 30×18 with a 14px thumb (SR-Kit 04); on is text-default, never an accent colour. */
export function SettingsSwitch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="settings-switch"
      className={cn(
        "inline-flex h-[18px] w-[30px] shrink-0 cursor-default items-center rounded-full bg-[light-dark(#0000001f,#ffffff1f)] p-0.5",
        "transition-colors duration-120 ease-out data-[state=checked]:bg-text-default disabled:opacity-(--opacity-dimmed)",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="bg-text-subtle data-[state=checked]:bg-raised block size-3.5 rounded-full transition-[translate,background-color] duration-120 ease-out data-[state=checked]:translate-x-3" />
    </SwitchPrimitive.Root>
  );
}

export interface SettingsStepperProps {
  readonly value: number;
  readonly onChange: (value: number) => void;
  /** Names the setting for the buttons ("Minimum context"). */
  readonly label: string;
  readonly min?: number;
  readonly max?: number;
  /** One press; the value snaps to it. Default 1. */
  readonly step?: number;
  /** The figure as shown ("200k", "5 min"). */
  readonly format?: (value: number) => string;
  readonly disabled?: boolean;
}

const STEP_BUTTON =
  "text-text-subtle hover:text-text-default h-full w-[26px] shrink-0 cursor-default text-[13px] disabled:opacity-(--opacity-dimmed)";

/** − value +, a 26px pill on raised-control; each press snaps to the step. */
export function SettingsStepper({
  value,
  onChange,
  label,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  format = String,
  disabled = false,
}: SettingsStepperProps) {
  const go = (direction: -1 | 1) => {
    const snapped = (direction < 0 ? Math.ceil(value / step) : Math.floor(value / step)) * step;
    const next = Math.min(max, Math.max(min, snapped + direction * step));

    if (next !== value) onChange(next);
  };

  return (
    <div
      data-slot="settings-stepper"
      role="group"
      aria-label={label}
      className={cn(
        "bg-raised-control flex h-[26px] shrink-0 items-center rounded-full border",
        CONTROL_EDGE
      )}
    >
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={disabled || value <= min}
        onClick={() => go(-1)}
        className={STEP_BUTTON}
      >
        −
      </button>
      <output
        aria-live="polite"
        className="text-text-strong tabular px-1 font-mono text-[12px] leading-4 font-medium"
      >
        {format(value)}
      </output>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={disabled || value >= max}
        onClick={() => go(1)}
        className={STEP_BUTTON}
      >
        +
      </button>
    </div>
  );
}

export interface SettingsOption<Value extends string> {
  readonly value: Value;
  /** The full wording, always shown in the menu. */
  readonly label: string;
  /** A short closed label for a narrow card ("Branch from default"). */
  readonly short?: string;
}

export interface SettingsSelectProps<Value extends string> {
  /** undefined is unset: the trigger is dashed and shows the placeholder. */
  readonly value: Value | undefined;
  readonly options: ReadonlyArray<SettingsOption<Value>>;
  readonly onChange: (value: Value) => void;
  readonly label: string;
  readonly placeholder?: string;
  /** The closed label in text-subtle, as an override that follows its default. */
  readonly muted?: boolean;
  readonly disabled?: boolean;
  readonly id?: string;
}

/** A 26px select on raised-control: a short closed label, the full wording in its menu. */
export function SettingsSelect<Value extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = "Choose",
  muted = false,
  disabled = false,
  id,
}: SettingsSelectProps<Value>) {
  const chosen = options.find((option) => option.value === value);
  const closed: ReactNode = chosen === undefined ? placeholder : (chosen.short ?? chosen.label);

  return (
    <Select
      {...(value === undefined ? {} : { value })}
      disabled={disabled}
      onValueChange={(next) => {
        const picked = options.find((option) => option.value === next);

        if (picked !== undefined) onChange(picked.value);
      }}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        data-unset={chosen === undefined ? "" : undefined}
        className={cn(
          "text-caption h-[26px] max-w-full gap-1.5 rounded-[8px] px-2.5 [&>svg:last-child]:size-2.5",
          chosen === undefined
            ? cn("bg-transparent", DASHED_EDGE)
            : cn("bg-raised-control", CONTROL_EDGE),
          muted && "text-text-subtle"
        )}
      >
        <SelectValue placeholder={placeholder}>{closed}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
