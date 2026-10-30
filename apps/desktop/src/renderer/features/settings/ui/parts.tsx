/**
 * The pieces every Settings page is built from (DESIGN.md, Settings): the page
 * header, a sub-heading, hairline groups with row dividers (never cards), a
 * setting row with fixed lanes, and the sunken footer strip. Redesigned pages (ENG-573) use
 * the Settings kit in @polaris/ui instead (packages/ui/src/components/polaris/settings).
 */
import { cn } from "@polaris/ui";
import type { ReactNode } from "react";

export const PageHeader = ({
  title,
  blurb,
}: {
  readonly title: string;
  readonly blurb: string;
}) => (
  <header className="flex flex-col gap-1.5">
    <h1 className="text-title text-text-strong font-medium">{title}</h1>
    <p className="text-body text-text-subtle">{blurb}</p>
  </header>
);

/** The centred 680px column (Paper S1–S4); narrow windows keep 16px each side. */
export const Column = ({ children }: { readonly children: ReactNode }) => (
  <div className="mx-auto flex w-[680px] max-w-[calc(100%-2rem)] flex-col gap-[calc(var(--spacing-section)+4px)] py-[calc(var(--spacing-section)+16px)]">
    {children}
  </div>
);

/** A group's heading, with an optional caption on the right. */
export const Heading = ({
  children,
  aside,
}: {
  readonly children: ReactNode;
  readonly aside?: ReactNode;
}) => (
  <div className="flex min-h-5 items-center justify-between gap-4">
    <h2 className="text-heading-sm text-text-strong leading-[18px] font-medium">{children}</h2>
    {aside}
  </div>
);

/** Raised white in light, flat on `bg` in dark, as in the mockups. */
const GROUP_FILL = "bg-[light-dark(var(--color-surface-raised),transparent)]";

/** Hairline-bordered, card radius, hairline row dividers. */
export const Group = ({
  children,
  className,
  label,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly label?: string;
}) => (
  <section
    aria-label={label}
    className={cn(
      "rounded-card border-hairline divide-hairline flex flex-col divide-y overflow-clip border",
      GROUP_FILL,
      className
    )}
  >
    {children}
  </section>
);

/** Settings as plain rows on the panel (Paper X-J): hairline dividers, no box; `ruled` adds one above. */
export const PlainRows = ({
  children,
  label,
  ruled = false,
}: {
  readonly children: ReactNode;
  readonly label: string;
  readonly ruled?: boolean;
}) => (
  <section
    aria-label={label}
    className={cn(
      "divide-hairline border-hairline flex flex-col divide-y border-b *:px-0",
      ruled && "border-t"
    )}
  >
    {children}
  </section>
);

/** A setting: its name and one caption line, then its control in the trailing lane. */
export const SettingRow = ({
  title,
  caption,
  children,
  htmlFor,
}: {
  readonly title: string;
  readonly caption: string;
  readonly children: ReactNode;
  /** The control's id, so the name labels it. */
  readonly htmlFor?: string;
}) => (
  <div className="px-panel flex items-center gap-4 py-[calc(var(--spacing-gap)+4px)]">
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <label htmlFor={htmlFor} className="text-label font-regular text-text-default">
        {title}
      </label>
      <span className="text-caption text-text-subtle">{caption}</span>
    </div>
    <div className="flex shrink-0 items-center gap-3">{children}</div>
  </div>
);

/** The sunken strip at a group's foot for secondary defaults. */
export const FooterStrip = ({ children }: { readonly children: ReactNode }) => (
  <div className="bg-surface-sunken px-panel gap-y-gap flex flex-wrap items-center gap-x-4 py-[calc(var(--spacing-gap)+2px)]">
    {children}
  </div>
);

/** A 2px track with a dark fill and a round thumb on stops; arrow keys step it. */
export const StepSlider = <Value extends string>({
  values,
  value,
  onChange,
  label,
  className,
  valueText,
}: {
  readonly values: ReadonlyArray<Value>;
  readonly value: Value;
  readonly onChange: (value: Value) => void;
  readonly label: string;
  readonly className?: string;
  readonly valueText: string;
}) => {
  const index = Math.max(0, values.indexOf(value));
  const last = values.length - 1;
  const at = (i: number) => `calc(${(i / last) * 100}% - ${(i / last) * 16}px)`;

  const step = (delta: number) => {
    const next = values[Math.min(last, Math.max(0, index + delta))];

    if (next !== undefined && next !== value) onChange(next);
  };

  const keys = new Map<string, number>([
    ["ArrowLeft", -1],
    ["ArrowDown", -1],
    ["ArrowRight", 1],
    ["ArrowUp", 1],
    ["Home", -last],
    ["End", last],
  ]);

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={index}
      aria-valuetext={valueText}
      onKeyDown={(event) => {
        const delta = keys.get(event.key);

        if (delta === undefined) return;
        event.preventDefault();
        step(delta);
      }}
      className={cn("relative h-4 shrink-0 cursor-default rounded-full", className)}
    >
      <span className="bg-fill-selected absolute inset-x-1.5 top-[7px] h-0.5" aria-hidden />
      <span
        className="bg-text-strong absolute top-[7px] left-1.5 h-0.5"
        style={{ width: at(index) }}
        aria-hidden
      />
      {values.map((v, i) => (
        <button
          key={v}
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={() => onChange(v)}
          className="absolute top-0 grid size-4 cursor-default place-items-center"
          style={{ left: at(i) }}
        >
          <span
            className={cn(
              "rounded-full",
              i === index
                ? "border-text-strong bg-[light-dark(#fff,var(--color-bg))] size-4 border shadow-[0_1px_2px_#0000001a]"
                : "bg-text-subtle size-1.5"
            )}
          />
        </button>
      ))}
    </div>
  );
};
