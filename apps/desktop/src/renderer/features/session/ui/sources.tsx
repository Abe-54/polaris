/**
 * The sources pill (DESIGN.md, Sources pill; Paper "Sources chip"): stacked dots, one per
 * domain, and "3 sources". It opens an instrument card listing each page the agent fetched
 * and each search it ran with the links it got back; links open in the browser.
 */
import { cn, InstrumentPopoverContent, Popover, PopoverTrigger } from "@polaris/ui";
import { polaris } from "../../bridge.ts";
import {
  type Source,
  type SourceLink,
  sourceDomains,
  sourcesLabel,
} from "../model/sources/index.ts";

const DOTS = 3;

/** The dots step down in weight, as in the mockup. */
const DOT_TONES = ["bg-text-subtle", "bg-text-faint", "bg-text-faint/50"];

const openUrl = (url: string) => void polaris().request("shell.openExternal", { url });

const Link = ({ title, url, domain }: SourceLink) => (
  <li>
    <button
      type="button"
      onClick={() => openUrl(url)}
      title={url}
      className="hover:bg-fill-hover flex w-full min-w-0 cursor-default flex-col rounded-[8px] px-2 py-1 text-left"
    >
      <span className="text-body text-text-default truncate">{title}</span>
      <span className="text-caption text-text-subtle truncate">
        {domain} · <span className="font-mono">{url}</span>
      </span>
    </button>
  </li>
);

const SourceItem = ({ source }: { readonly source: Source }) =>
  source.kind === "fetch" ? (
    <ul className="flex flex-col" data-testid="source-fetch">
      <Link title={source.domain} url={source.url} domain={source.domain} />
    </ul>
  ) : (
    <div className="flex flex-col gap-0.5" data-testid="source-search">
      <p className="text-caption text-text-subtle px-2 pt-1">
        Searched <span className="text-text-default">{source.query}</span>
      </p>
      {source.links.length === 0 ? null : (
        <ul className="flex flex-col">
          {source.links.map((link) => (
            <Link key={link.url} {...link} />
          ))}
        </ul>
      )}
    </div>
  );

export const SourcesPill = ({
  sources,
  align = "start",
}: {
  readonly sources: ReadonlyArray<Source>;
  /** Which edge of the pill the card lines up with: "end" where the pill sits at the right. */
  readonly align?: "start" | "end";
}) => {
  const label = sourcesLabel(sources);
  const dots = sourceDomains(sources).slice(0, DOTS);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="sources-pill"
          className="bg-well hover:bg-fill-hover flex h-[26px] cursor-default items-center gap-2 self-start rounded-full pr-[11px] pl-2"
        >
          <span className="flex" aria-hidden="true">
            {dots.map((domain, n) => (
              <span
                key={domain}
                className={cn(
                  "ring-well size-3 shrink-0 rounded-full ring-2",
                  DOT_TONES[n],
                  n > 0 && "-ml-1"
                )}
              />
            ))}
          </span>
          <span className="text-caption text-text-subtle tabular">{label}</span>
        </button>
      </PopoverTrigger>
      <InstrumentPopoverContent
        align={align}
        data-testid="sources-popover"
        header={{ title: "Sources", state: sources.length }}
        wells={[
          <div key="sources" className="flex flex-col gap-1 p-1">
            {sources.map((source) => (
              <SourceItem key={source.id} source={source} />
            ))}
          </div>,
        ]}
      />
    </Popover>
  );
};
