/**
 * The service panel (DESIGN.md, Traces → Service map; Paper T5): the selected service's
 * Requests, Request time, Spans and Errors; Calls with totals as bars and any N+1 in a line;
 * Called by; Slowest requests, each opening the waterfall at its span. This trace only.
 */
import { CloseIcon, cn, IconButton } from "@polaris/ui";
import type { ReactNode } from "react";
import { formatDuration } from "../../model/format.ts";
import type { NodeKind, ServicePanelModel } from "../../model/map/index.ts";
import { turnWords } from "../../model/map/words.ts";
import { serviceHue } from "../../model/waterfall/index.ts";
import { KICKER } from "../span/parts.tsx";

const Swatch = ({ kind, hue, size }: { kind: NodeKind; hue: number | null; size: number }) => (
  <span
    aria-hidden
    className={cn("shrink-0 rounded-[2px]", hue === null && "ring-text-subtle ring-1 ring-inset")}
    style={{
      width: size,
      height: size,
      background: kind === "service" && hue !== null ? serviceHue(hue) : undefined,
    }}
  />
);

const Tile = ({ value, label }: { readonly value: string; readonly label: string }) => (
  <div className="bg-well flex flex-col gap-0.5 px-3 py-2.5">
    <span className="text-heading tabular text-text-strong font-mono font-medium">{value}</span>
    <span className="text-caption text-text-subtle">{label}</span>
  </div>
);

const Section = ({
  title,
  end,
  children,
}: {
  title: string;
  end?: string;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-2 px-4 pt-5">
    <div className="flex justify-between">
      <h3 className={cn(KICKER, "text-text-subtle")}>{title}</h3>
      {end === undefined ? null : <span className={cn(KICKER, "text-text-subtle")}>{end}</span>}
    </div>
    {children}
  </section>
);

const ROW =
  "hover:bg-fill-hover focus-visible:ring-starlight -mx-2 flex h-7 cursor-default items-center gap-2 rounded-control px-2 text-left outline-none focus-visible:ring-2";

const Calls = ({
  model,
  onSelect,
}: {
  model: ServicePanelModel;
  onSelect: (name: string) => void;
}) => (
  <Section title={`Calls · ${model.calls.length}`} end="Total">
    <div className="flex flex-col">
      {model.calls.map((c) => (
        <button
          key={c.name}
          type="button"
          className={ROW}
          onClick={() => onSelect(c.name)}
          data-testid="service-call"
        >
          <Swatch kind={c.kind} hue={c.hue} size={6} />
          <span
            className="text-caption text-text-default w-[96px] shrink-0 truncate font-mono"
            title={c.name}
          >
            {c.name}
          </span>
          <span
            className={cn(
              "tabular w-10 shrink-0 font-mono text-[11px] leading-[14px]",
              c.nPlusOne ? "text-git-modified-text" : "text-text-subtle"
            )}
          >
            ×{c.calls}
          </span>
          <span className="bg-hairline relative h-1.5 min-w-0 flex-1 rounded-[2px]">
            <span
              className="absolute inset-y-0 left-0 rounded-[2px]"
              style={{
                width: `${Math.max(2, c.share * 100)}%`,
                background: `color-mix(in oklab, ${c.kind === "service" ? serviceHue(c.hue ?? undefined) : "var(--color-text-subtle)"} 65%, transparent)`,
              }}
            />
          </span>
          <span className="tabular text-text-subtle w-[52px] shrink-0 text-right font-mono text-[11px] leading-[14px]">
            {formatDuration(c.ms)}
          </span>
        </button>
      ))}
    </div>
    {model.nPlusOne.map((line) => (
      <p key={line} className="text-caption text-text-subtle" data-testid="service-n-plus-one">
        {line}
      </p>
    ))}
  </Section>
);

const CalledBy = ({
  model,
  onSelect,
}: {
  model: ServicePanelModel;
  onSelect: (name: string) => void;
}) => (
  <Section title="Called by">
    <div className="flex flex-col">
      {model.startedBy === null ? null : (
        <div className="flex h-7 items-center gap-2" data-testid="service-started-by">
          <span
            className="text-caption text-text-default min-w-0 truncate font-mono"
            title={model.startedBy.command ?? undefined}
          >
            {model.startedBy.command ?? "Outside this trace"}
          </span>
          <span className="text-text-subtle shrink-0 font-mono text-[11px] leading-4">
            {turnWords(model.startedBy)}
          </span>
        </div>
      )}
      {model.calledBy.map((c) => (
        <button key={c.name} type="button" className={ROW} onClick={() => onSelect(c.name)}>
          <Swatch kind={c.kind} hue={c.hue} size={6} />
          <span className="text-caption text-text-default min-w-0 truncate font-mono">
            {c.name}
          </span>
          <span className="tabular text-text-subtle shrink-0 font-mono text-[11px] leading-4">
            ×{c.calls}
          </span>
        </button>
      ))}
    </div>
  </Section>
);

const Slowest = ({
  model,
  onOpen,
}: {
  model: ServicePanelModel;
  onOpen: (spanId: string) => void;
}) => {
  const [first] = model.slowest;

  return (
    <Section title={model.node.kind === "service" ? "Slowest requests" : "Slowest calls"}>
      <div className="flex flex-col">
        {model.slowest.map((s) => (
          <button
            key={s.span.id}
            type="button"
            className={ROW}
            onClick={() => onOpen(s.span.id)}
            data-testid="service-slowest"
          >
            <span
              className={cn(
                "text-caption min-w-0 flex-1 truncate font-mono",
                s.span.status === "error" ? "text-severity-critical-text" : "text-text-default"
              )}
              title={s.span.name}
            >
              {s.span.name}
            </span>
            <span className="tabular text-text-subtle shrink-0 font-mono text-[11px] leading-[14px]">
              {formatDuration(s.end - s.start)}
            </span>
          </button>
        ))}
      </div>
      {first === undefined ? null : (
        <button
          type="button"
          onClick={() => onOpen(first.span.id)}
          className="text-caption text-text-subtle hover:text-text-default focus-visible:ring-starlight rounded-control w-fit cursor-default outline-none focus-visible:ring-2"
        >
          Open in waterfall
        </button>
      )}
    </Section>
  );
};

export const ServicePanel = ({
  model,
  onSelect,
  onClose,
  onOpen,
}: {
  readonly model: ServicePanelModel;
  readonly onSelect: (name: string) => void;
  readonly onClose: () => void;
  readonly onOpen: (spanId: string) => void;
}) => {
  const { node } = model;

  return (
    <aside
      aria-label="Service"
      data-testid="service-panel"
      className="border-hairline bg-panel flex w-[360px] min-w-0 shrink-0 flex-col overflow-y-auto border-l pb-4"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 pr-3 pl-4">
        <span className={cn(KICKER, "text-text-subtle font-medium")}>
          {node.kind === "service" ? "Service" : "Inferred"}
        </span>
        <Swatch kind={node.kind} hue={node.hue} size={8} />
        <h2
          className="text-body text-text-strong min-w-0 flex-1 truncate font-mono font-medium"
          title={node.name}
        >
          {node.name}
        </h2>
        <IconButton
          size="sm"
          label="Close service"
          icon={<CloseIcon size={14} />}
          onClick={onClose}
        />
      </div>
      <div className="border-hairline bg-hairline rounded-row mx-4 grid shrink-0 grid-cols-2 gap-px overflow-hidden border">
        <Tile
          value={String(node.requests.length)}
          label={node.kind === "service" ? "Requests" : "Calls"}
        />
        <Tile
          value={formatDuration(node.requestMs)}
          label={node.kind === "service" ? "Request time" : "Call time"}
        />
        <Tile value={String(node.spans)} label="Spans" />
        <Tile value={String(node.errors)} label="Errors" />
      </div>
      {model.calls.length === 0 ? null : <Calls model={model} onSelect={onSelect} />}
      <CalledBy model={model} onSelect={onSelect} />
      <Slowest model={model} onOpen={onOpen} />
    </aside>
  );
};
