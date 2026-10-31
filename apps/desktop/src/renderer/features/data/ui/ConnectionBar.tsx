/**
 * The connection bar above the tabs (DESIGN.md, Data → Connection bar; Paper D1/D3): the label
 * kicker, engine and version, host:port, database and table in mono, then the agents' access.
 * A coloured label tints the bar (rule/data-source-label); clicking opens its instrument card.
 */
import type { DataSource } from "@polaris/protocol";
import { cn, Popover, PopoverTrigger } from "@polaris/ui";
import { useState } from "react";
import { useApp } from "../../../shell/hooks.ts";
import { useDataSources } from "../data/hooks.tsx";
import { refreshSources } from "../model/refresh.ts";
import { accessShort, accessText, barParts, kickerText, LABEL_TONES } from "../model/source.ts";
import type { DataTab } from "../model/tabs.ts";
import { useSqlSource } from "../sql/state.ts";
import { ConnectionCard } from "./connection/ConnectionCard.tsx";
import type { DataSlotProps } from "./slots.ts";

const BAR =
  "h-row mx-gap mt-gap rounded-row gap-row-x @container flex shrink-0 items-center px-3 text-left ring-1 ring-inset";

/**
 * Where a query would go: the active tab's source (a SQL tab's chosen one), else the first. A tab
 * whose source isn't listed is `gone`, never shown as another source.
 */
const shownSource = (
  sources: ReadonlyArray<DataSource>,
  active: DataTab | null,
  sqlSource: string | null
): { readonly source: DataSource } | { readonly gone: string } | null => {
  if (active === null) return sources[0] === undefined ? null : { source: sources[0] };
  const name = sqlSource ?? active.sourceId;
  const source = sources.find((s) => s.name === name);

  return source === undefined ? { gone: name } : { source };
};

/** Access words in text-subtle whatever the label (rule/data-source-label), short when narrow. */
const Access = ({ source }: { readonly source: DataSource }) => {
  if (source.reachable === false)
    return (
      <span className="text-caption text-failed-text shrink-0" data-testid="data-connection-access">
        Can't reach it
      </span>
    );
  const needsYou = source.access === "needs-approval";
  const tone = needsYou ? "text-text-default" : "text-text-subtle";

  return (
    <span
      className={cn("text-caption shrink-0 whitespace-nowrap", tone)}
      title={accessText(source)}
    >
      <span className="hidden @min-[640px]:inline" data-testid="data-connection-access">
        {accessText(source)}
      </span>
      <span className="@min-[640px]:hidden" data-testid="data-connection-access-short">
        {accessShort(source)}
      </span>
    </span>
  );
};

const Divider = ({ red }: { readonly red: boolean }) => (
  <span className={cn("h-3.5 w-px shrink-0", red ? "bg-severity-critical/40" : "bg-hairline")} />
);

/** The tab's source isn't in the checkout's list: say so, with no label colour. */
const GoneBar = ({ name, active }: { readonly name: string; readonly active: DataTab }) => (
  <div data-testid="data-connection-bar" data-gone="" className={cn(BAR, "bg-well ring-hairline")}>
    <span
      className="text-micro text-text-subtle shrink-0 font-mono font-medium tracking-[0.06em]"
      data-testid="data-connection-kicker"
    >
      NOT IN THIS CHECKOUT
    </span>
    <Divider red={false} />
    <span className="text-caption text-text-default min-w-0 flex-1 truncate font-mono" dir="auto">
      {name}
    </span>
    <span className="text-caption text-text-subtle shrink-0" data-testid="data-connection-access">
      {active.kind === "sql" ? "Choose a data source in the run bar" : "Its data source is gone"}
    </span>
  </div>
);

export const ConnectionBar = ({ at, hostKey, active }: DataSlotProps) => {
  const sources = useDataSources(at);
  const sqlSource = useSqlSource(at, active);
  const [open, setOpen] = useState(false);

  const connected = useApp(
    (s) => s.hosts.find((h) => h.key === hostKey)?.status.state === "connected"
  );

  const shown = sources.status === "ready" ? shownSource(sources.value, active, sqlSource) : null;

  if (shown === null) return null;

  if ("gone" in shown)
    return active === null ? null : <GoneBar name={shown.gone} active={active} />;
  const { source } = shown;
  const colour = source.label.colour;
  const tone = LABEL_TONES[colour];
  const table = active?.kind === "table" && active.sourceId === source.name ? active.table : null;
  const kicker = kickerText(source);

  return (
    // Opening the card re-lists, so an approval in it targets what the checkout holds now.
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);

        if (next) refreshSources(at);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="data-connection-bar"
          data-colour={colour}
          aria-label={`${source.name} connection`}
          className={cn(
            BAR,
            "focus-visible:ring-starlight cursor-default outline-none focus-visible:ring-2",
            tone.ground,
            !connected && "opacity-(--opacity-dimmed)"
          )}
        >
          <span
            className={cn(
              "text-micro max-w-[24ch] shrink-0 truncate font-mono font-medium tracking-[0.06em]",
              colour === "none" ? "text-text-subtle" : tone.text
            )}
            title={kicker}
            dir="auto"
            data-testid="data-connection-kicker"
          >
            {kicker}
          </span>
          <Divider red={colour === "red"} />
          <span
            className={cn(
              "text-caption min-w-0 flex-1 truncate font-mono",
              colour === "red" ? "text-text-strong" : "text-text-default"
            )}
            data-testid="data-connection-where"
          >
            {barParts(source).join(" : ")}
            {table === null ? null : (
              <>
                {" : "}
                <span className="text-text-strong font-medium" dir="auto">
                  {table}
                </span>
              </>
            )}
          </span>
          <Access source={source} />
        </button>
      </PopoverTrigger>
      <ConnectionCard
        key={source.id}
        at={at}
        source={source}
        canEdit={connected}
        onRemoved={() => setOpen(false)}
      />
    </Popover>
  );
};
