import { ToggleGroup } from "radix-ui";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { cn } from "../../lib/cn";

export interface SegmentedOption<Value extends string> {
  readonly value: Value;
  readonly label: ReactNode;
  /** A count or badge after the label. */
  readonly badge?: ReactNode;
  readonly disabled?: boolean;
}

const SEGMENT_SIZE = {
  mode: "h-[26px] px-2.5 text-label",
  fill: "h-6 flex-1 gap-1.5 text-caption font-medium",
  well: "px-2.5 py-[3px] text-caption font-regular data-[state=on]:font-medium",
} as const;

const PILL_SIZE = {
  mode: "h-[30px] gap-2 rounded-full px-3.5",
  fill: "h-7 rounded-full",
  well: "",
} as const;

export interface SegmentedControlProps<Value extends string> {
  readonly options: readonly SegmentedOption<Value>[];
  /** `null` selects nothing; every segment stays focusable and clickable. */
  readonly value: Value | null;
  readonly onValueChange: (value: Value) => void;
  /**
   * "mode" is the title-bar switch (26px segments); "fill" stretches equal segments (24px);
   * "well" is the small sunken range control (Settings → Usage: 7 / 30 / 90 days).
   */
  readonly variant?: "mode" | "fill" | "well";
  /**
   * Pill tabs on the ground (DESIGN.md, Chrome redesign: Controls): a round track in the panel
   * fill with round segments, 30px in "mode", 28px in "fill". Not for "well".
   */
  readonly pill?: boolean;
  readonly "aria-label": string;
  readonly className?: string;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Box extends Size {
  readonly left: number;
  readonly top: number;
}

const percent = (part: number, whole: number) => `${Math.round((part / whole) * 100_000) / 1000}%`;

/**
 * The selected segment's box as a clip of the whole track, in percentages so it holds while an
 * ancestor scales. Null for a track with no size (one that is hidden).
 */
export const pillClip = (track: Size, segment: Box): string | null => {
  if (track.width === 0 || track.height === 0) return null;

  const right = track.width - segment.left - segment.width;
  const bottom = track.height - segment.top - segment.height;

  return `inset(${percent(segment.top, track.height)} ${percent(right, track.width)} ${percent(bottom, track.height)} ${percent(segment.left, track.width)} round 999px)`;
};

interface Pill {
  /** The clip of the selected segment, or null when nothing is selected. */
  readonly clip: string | null;
  /** Whether this clip came from a new selection (slide) or a resize (jump). */
  readonly slide: boolean;
}

const measure = (track: HTMLElement): string | null => {
  const on = track.querySelector<HTMLElement>('[data-state="on"]');
  const pill = track.querySelector<HTMLElement>('[data-slot="segmented-pill"]');

  if (on === null || pill === null) return null;

  const outer = pill.getBoundingClientRect();
  const box = on.getBoundingClientRect();

  return pillClip(
    { width: outer.width, height: outer.height },
    { left: box.left - outer.left, top: box.top - outer.top, width: box.width, height: box.height }
  );
};

/**
 * One choice among a few (Orchestrate / Review / Edit; Sessions / Needs you), always a pill:
 * a well track inside a surface, the panel fill on the ground (`pill`). Selection is one
 * fill-selected pill that slides to the chosen segment, never an accent colour. Arrow keys
 * move between segments.
 */
export function SegmentedControl<Value extends string>({
  options,
  value,
  onValueChange,
  variant = "mode",
  pill = false,
  className,
  ...props
}: SegmentedControlProps<Value>) {
  const choose = (next: string) => {
    const option = options.find((candidate) => candidate.value === next);

    if (option !== undefined) onValueChange(option.value);
  };

  const track = useRef<HTMLDivElement>(null);
  const [pillAt, setPillAt] = useState<Pill>({ clip: null, slide: false });

  // A new selection slides the pill to its segment.
  useLayoutEffect(() => {
    if (track.current !== null) setPillAt({ clip: measure(track.current), slide: true });
  }, [value]);

  // A resize (a badge, the window, the density) moves it without sliding.
  useLayoutEffect(() => {
    const element = track.current;

    if (element === null || typeof ResizeObserver === "undefined") return undefined;

    const observer = new ResizeObserver(() => {
      const clip = measure(element);

      setPillAt((current) => (current.clip === clip ? current : { clip, slide: false }));
    });

    observer.observe(element);

    for (const item of element.querySelectorAll("[data-state]")) observer.observe(item);

    return () => observer.disconnect();
  }, [options.length]);

  return (
    <ToggleGroup.Root
      ref={track}
      type="single"
      value={value ?? ""}
      onValueChange={choose}
      aria-label={props["aria-label"]}
      data-slot="segmented-control"
      className={cn(
        "relative isolate flex items-center gap-0.5 rounded-full border border-hairline bg-well p-0.5",
        variant === "fill" && "w-full",
        variant === "well" && "gap-0",
        pill && "rounded-full border-0 bg-panel p-[3px]",
        className
      )}
    >
      <span
        aria-hidden
        data-slot="segmented-pill"
        className={cn(
          "pointer-events-none absolute inset-0 -z-10 bg-fill-selected",
          pillAt.clip === null && "opacity-0",
          pillAt.slide && "transition-[clip-path] duration-160 ease-out"
        )}
        style={pillAt.clip === null ? undefined : { clipPath: pillAt.clip }}
      />
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={cn(
            "group/segment flex cursor-default items-center justify-center gap-2 rounded-full font-medium text-text-subtle select-none",
            "hover:text-text-default data-[state=on]:text-text-strong",
            "disabled:opacity-(--opacity-dimmed)",
            SEGMENT_SIZE[variant],
            pill && PILL_SIZE[variant]
          )}
        >
          {option.label}
          {option.badge}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
