/**
 * The Services chip and its popover (DESIGN.md, Traces → Services chip; Paper T1): each service's
 * hue, name, span count and time. Hovering a service lights its spans; clicking shows only them.
 * Its name always sits beside its colour (rule/no-colour-alone).
 */
import { cn, Popover, PopoverAnchor, PopoverContent } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import { durationLabel, type ServiceStat, serviceHue } from "../../model/waterfall/index.ts";

/** Long enough to cross from the chip to the popover without it closing. */
const CLOSE_MS = 150;

const Swatch = ({ index }: { readonly index: number }) => (
  <span
    aria-hidden
    className="size-2 shrink-0 rounded-[2px]"
    style={{ background: serviceHue(index) }}
  />
);

export interface ServicesChipProps {
  readonly services: ReadonlyArray<ServiceStat>;
  readonly only: string | null;
  readonly onOnly: (service: string | null) => void;
  readonly onHover: (service: string | null) => void;
}

const useHoverOpen = () => {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => cancel, []);

  return {
    open,
    setOpen,
    enter: () => {
      cancel();
      setOpen(true);
    },
    leave: () => {
      cancel();
      timer.current = setTimeout(() => setOpen(false), CLOSE_MS);
    },
  };
};

export const ServicesChip = ({ services, only, onOnly, onHover }: ServicesChipProps) => {
  const { open, setOpen, enter, leave } = useHoverOpen();

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);

        if (!next) onHover(null);
      }}
    >
      <PopoverAnchor asChild>
        <button
          type="button"
          data-testid="waterfall-services"
          aria-haspopup="dialog"
          aria-expanded={open}
          onPointerEnter={enter}
          onPointerLeave={leave}
          onClick={() => setOpen(!open)}
          className={cn(
            "bg-raised-control ring-hairline focus-visible:ring-starlight flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-full px-2.5 ring-1 ring-inset outline-none focus-visible:ring-2",
            only !== null && "bg-fill-selected"
          )}
        >
          <span className="flex items-center">
            {services.slice(0, 5).map((s) => (
              <span
                key={s.name}
                className="ring-raised-control -ml-0.5 size-2 rounded-[2px] ring-2 first:ml-0"
                style={{ background: serviceHue(s.index) }}
              />
            ))}
          </span>
          <span className="text-caption text-text-default font-medium whitespace-nowrap">
            {only === null ? "Services" : `${only} only`}
          </span>
          <span className="text-micro text-text-subtle font-mono">{services.length}</span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="flex w-[260px] flex-col gap-0.5 p-2"
        onPointerEnter={enter}
        onPointerLeave={() => {
          onHover(null);
          leave();
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        data-testid="waterfall-services-popover"
      >
        <p className="text-micro text-text-subtle px-1.5 pt-1 pb-1.5 font-mono font-medium tracking-[0.06em]">
          SERVICES IN THIS TRACE
        </p>
        {services.map((s) => (
          <button
            key={s.name}
            type="button"
            aria-pressed={only === s.name}
            data-testid="waterfall-service"
            onPointerEnter={() => onHover(s.name)}
            onFocus={() => onHover(s.name)}
            onClick={() => onOnly(only === s.name ? null : s.name)}
            className="hover:bg-fill-hover aria-pressed:bg-fill-selected focus-visible:ring-starlight rounded-control flex h-7 shrink-0 cursor-default items-center gap-2 px-1.5 outline-none focus-visible:ring-2"
          >
            <Swatch index={s.index} />
            <span className="text-code-inline text-text-default min-w-0 flex-1 truncate text-left font-mono">
              {s.name}
            </span>
            <span className="text-micro text-text-subtle shrink-0 font-mono whitespace-nowrap">
              {s.spans.toLocaleString("en-US")} {s.spans === 1 ? "span" : "spans"}
            </span>
            <span className="text-micro text-text-subtle w-12 shrink-0 text-right font-mono whitespace-nowrap">
              {durationLabel(s.ms)}
            </span>
          </button>
        ))}
        <p className="text-caption text-text-subtle px-1.5 pt-1.5 pb-1">
          {only === null
            ? "Hover a service to highlight its spans; click to show only them."
            : "Click it again to show every service."}
        </p>
      </PopoverContent>
    </Popover>
  );
};
