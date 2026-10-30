import { useId, type ReactNode } from "react";

import { cn } from "../../../lib/cn";
import {
  SettingsSelect,
  SettingsStepper,
  SettingsSwitch,
  type SettingsOption,
  type SettingsSelectProps,
  type SettingsStepperProps,
} from "./controls";
import { DASHED_EDGE, LANE_PAD, ROW_PAD } from "./tones";

export interface SettingsRowProps {
  readonly title: ReactNode;
  /** One caption line; anything longer belongs in the card's footer. */
  readonly caption?: ReactNode | undefined;
  /** The control in the trailing lane. */
  readonly children?: ReactNode;
  /** The control's id, so the title labels it. */
  readonly htmlFor?: string | undefined;
  /** Indented under the row it depends on, at opacity-dimmed while that is off. */
  readonly nested?: boolean | undefined;
  readonly dimmed?: boolean | undefined;
  /** Title and caption wrap to two lines instead of truncating, for a narrow two-up card (SR-10). */
  readonly wrap?: boolean | undefined;
  readonly className?: string | undefined;
}

/** A setting in a well: title 13/18, caption 12/16, its control trailing. */
export function SettingsRow({
  title,
  caption,
  children,
  htmlFor,
  nested = false,
  dimmed = false,
  wrap = false,
  className,
}: SettingsRowProps) {
  const fit = wrap ? "line-clamp-2" : "truncate";

  return (
    <div
      data-slot="settings-row"
      className={cn(
        "flex items-center gap-3",
        ROW_PAD,
        nested && "pl-[calc(var(--spacing-panel)+24px)]",
        dimmed && "opacity-(--opacity-dimmed)",
        className
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={htmlFor} className={cn("text-body text-text-default", fit)}>
          {title}
        </label>
        {caption === undefined ? null : (
          <span className={cn("text-caption text-text-subtle", fit)}>{caption}</span>
        )}
      </div>
      {children === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      )}
    </div>
  );
}

export interface SettingsToggleRowProps extends Omit<SettingsRowProps, "children" | "htmlFor"> {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}

export function SettingsToggleRow({
  checked,
  onCheckedChange,
  disabled,
  ...row
}: SettingsToggleRowProps) {
  const id = useId();

  return (
    <SettingsRow {...row} htmlFor={id}>
      <SettingsSwitch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
    </SettingsRow>
  );
}

export type SettingsStepperRowProps = Omit<SettingsRowProps, "children" | "htmlFor" | "title"> &
  Omit<SettingsStepperProps, "label"> & { readonly title: string; readonly label?: string };

export function SettingsStepperRow({
  title,
  caption,
  nested,
  dimmed,
  wrap,
  className,
  label,
  ...stepper
}: SettingsStepperRowProps) {
  return (
    <SettingsRow {...{ title, caption, nested, dimmed, wrap, className }}>
      <SettingsStepper label={label ?? title} {...stepper} />
    </SettingsRow>
  );
}

export type SettingsSelectRowProps<Value extends string> = Omit<
  SettingsRowProps,
  "children" | "htmlFor" | "title"
> &
  Omit<SettingsSelectProps<Value>, "label" | "id"> & {
    readonly title: string;
    readonly label?: string;
  };

export function SettingsSelectRow<Value extends string>({
  title,
  caption,
  nested,
  dimmed,
  wrap,
  className,
  label,
  ...select
}: SettingsSelectRowProps<Value>) {
  const id = useId();

  return (
    <SettingsRow htmlFor={id} {...{ title, caption, nested, dimmed, wrap, className }}>
      <SettingsSelect id={id} label={label ?? title} {...select} />
    </SettingsRow>
  );
}

export interface SettingsHostRowProps {
  readonly name: string;
  /** The host's own colour (its square): identity, never state. */
  readonly colour: string;
  /** One mono fact ("macOS arm64", "Offline · last seen 2h ago"). */
  readonly fact?: ReactNode;
  /** Dims the row to 55% and replaces the control with "Not connected". */
  readonly offline?: boolean;
  readonly children?: ReactNode;
}

/** A per-host row in fixed lanes: colour square, name (160px), mono fact, control. */
export function SettingsHostRow({
  name,
  colour,
  fact,
  offline = false,
  children,
}: SettingsHostRowProps) {
  return (
    <div
      data-slot="settings-host-row"
      data-offline={offline ? "" : undefined}
      className={cn("flex items-center gap-3", LANE_PAD, offline && "opacity-(--opacity-dimmed)")}
    >
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-[3px]"
        style={{ backgroundColor: colour }}
      />
      <span className="text-body text-text-default w-40 shrink-0 truncate">{name}</span>
      <span className="text-text-subtle min-w-0 flex-1 truncate font-mono text-[11px] leading-4">
        {fact}
      </span>
      {offline ? (
        <span
          className={cn(
            "text-caption text-text-subtle flex h-[26px] shrink-0 items-center rounded-[8px] border px-2.5",
            DASHED_EDGE
          )}
        >
          Not connected
        </span>
      ) : (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      )}
    </div>
  );
}

/** The value of an override that follows its default. */
export const FOLLOWS_DEFAULT = "default";

export interface SettingsOverrideRowProps<Value extends string> {
  readonly name: string;
  /** null follows the default. */
  readonly value: Value | null;
  readonly options: ReadonlyArray<SettingsOption<Value>>;
  /** The default's own label, read into the first choice: "Default · After 7 days". */
  readonly defaultLabel: string;
  readonly onChange: (value: Value | null) => void;
  /** What it overrides, for the caption: "the host" → "Follows the host". */
  readonly parent?: string;
  /** The × lane: clears the override; its lane is kept when there is none. */
  readonly clearLabel?: string;
  /** Replaces "Follows/Overrides the host" with the row's own line ("12.4 MB in 8 files"). */
  readonly caption?: ReactNode;
}

const isOverride = <Value extends string>(
  next: Value | typeof FOLLOWS_DEFAULT,
  options: ReadonlyArray<SettingsOption<Value>>
): next is Value => options.some((option) => option.value === next);

/** A workspace override under the default it overrides, "Default · …" its first choice. */
export function SettingsOverrideRow<Value extends string>({
  name,
  value,
  options,
  defaultLabel,
  onChange,
  parent = "the host",
  clearLabel = `Follow ${parent} for ${name}`,
  caption,
}: SettingsOverrideRowProps<Value>) {
  const choices: ReadonlyArray<SettingsOption<Value | typeof FOLLOWS_DEFAULT>> = [
    { value: FOLLOWS_DEFAULT, label: `Default · ${defaultLabel}` },
    ...options,
  ];

  return (
    <div data-slot="settings-override-row" className={cn("flex items-center gap-3", LANE_PAD)}>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-body text-text-default truncate">{name}</span>
        <span className="text-caption text-text-subtle truncate">
          {caption ?? (value === null ? `Follows ${parent}` : `Overrides ${parent}`)}
        </span>
      </div>
      <SettingsSelect
        label={name}
        value={value ?? FOLLOWS_DEFAULT}
        options={choices}
        muted={value === null}
        onChange={(next) => onChange(isOverride(next, options) ? next : null)}
      />
      <span className="flex size-6 shrink-0 items-center justify-center">
        {value === null ? null : (
          <button
            type="button"
            aria-label={clearLabel}
            onClick={() => onChange(null)}
            className="text-text-subtle hover:text-text-default hover:bg-fill-hover flex size-6 cursor-default items-center justify-center rounded-full"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path
                d="M2.5 2.5l5 5M7.5 2.5l-5 5"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </span>
    </div>
  );
}
