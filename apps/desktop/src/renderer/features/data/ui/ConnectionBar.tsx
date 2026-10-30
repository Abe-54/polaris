/**
 * The connection bar above the tabs (DESIGN.md, Data → Connection bar; Paper D1/D3): the label
 * kicker, engine and version, host:port, database and table in mono, then the agents' access.
 * A coloured label tints the bar (rule/data-source-label); clicking opens its instrument card.
 */
import type { DataSource } from "@polaris/protocol";
import { cn, Popover, PopoverTrigger } from "@polaris/ui";
import { useApp } from "../../../shell/hooks.ts";
import { useDataSources } from "../data/hooks.tsx";
import { accessText, barParts, kickerText, LABEL_TONES } from "../model/source.ts";
import type { DataTab } from "../model/tabs.ts";
import { ConnectionCard } from "./connection/ConnectionCard.tsx";
import type { DataSlotProps } from "./slots.ts";

/** The active tab's source, else the first: the bar always names where a new query would go. */
const shownSource = (sources: ReadonlyArray<DataSource>, active: DataTab | null) =>
  sources.find((s) => s.name === active?.sourceId) ?? sources[0] ?? null;

const Access = ({ source, tone }: { readonly source: DataSource; readonly tone: string }) =>
  source.reachable ? (
    <span className={cn("text-caption shrink-0", tone)} data-testid="data-connection-access">
      {accessText(source)}
    </span>
  ) : (
    <span className="text-caption text-failed-text shrink-0" data-testid="data-connection-access">
      Can't reach it
    </span>
  );

export const ConnectionBar = ({ at, hostKey, active }: DataSlotProps) => {
  const sources = useDataSources(at);

  const connected = useApp(
    (s) => s.hosts.find((h) => h.key === hostKey)?.status.state === "connected"
  );

  const source = sources.status === "ready" ? shownSource(sources.value, active) : null;

  if (source === null) return null;
  const colour = source.label.colour;
  const tone = LABEL_TONES[colour];
  const table = active?.kind === "table" && active.sourceId === source.name ? active.table : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="data-connection-bar"
          data-colour={colour}
          aria-label={`${source.name} connection`}
          className={cn(
            "h-row mx-gap mt-gap rounded-row gap-row-x flex shrink-0 cursor-default items-center px-3 text-left ring-1 ring-inset",
            "focus-visible:ring-starlight outline-none focus-visible:ring-2",
            tone.ground,
            !connected && "opacity-(--opacity-dimmed)"
          )}
        >
          <span
            className={cn(
              "text-micro shrink-0 font-mono font-medium tracking-[0.06em]",
              colour === "none" ? "text-text-subtle" : tone.text
            )}
            data-testid="data-connection-kicker"
          >
            {kickerText(source)}
          </span>
          <span
            className={cn(
              "h-3.5 w-px shrink-0",
              colour === "red" ? "bg-severity-critical/40" : "bg-hairline"
            )}
          />
          <span
            className={cn(
              "text-caption min-w-0 flex-1 truncate font-mono",
              colour === "red" ? "text-text-strong" : "text-text-default"
            )}
          >
            {barParts(source).join(" : ")}
            {table === null ? null : (
              <>
                {" : "}
                <span className="text-text-strong font-medium">{table}</span>
              </>
            )}
          </span>
          <Access source={source} tone={colour === "none" ? "text-text-subtle" : tone.text} />
        </button>
      </PopoverTrigger>
      <ConnectionCard at={at} source={source} canEdit={connected} />
    </Popover>
  );
};
