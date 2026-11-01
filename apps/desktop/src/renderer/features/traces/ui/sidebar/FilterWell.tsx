/**
 * The filter well above the traces (DESIGN.md, Traces → Sidebar; Paper T1): one line of
 * `route:` `service:` `status:` `>100ms` words, read as a TraceFilter once typing pauses.
 */
import type { TraceFilter } from "@polaris/protocol";
import { SearchIcon } from "@polaris/ui";
import { useEffect, useState } from "react";
import { parseTraceFilter } from "../../model/sidebar.ts";

/** Long enough that each key doesn't restart the Daemon's watch. */
const PAUSE_MS = 200;

export const FilterWell = ({
  onFilter,
}: {
  readonly onFilter: (filter: TraceFilter | undefined) => void;
}) => {
  const [text, setText] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => onFilter(parseTraceFilter(text)), PAUSE_MS);

    return () => clearTimeout(timer);
  }, [text, onFilter]);

  return (
    <label className="bg-well ring-hairline focus-within:ring-starlight flex h-[30px] shrink-0 items-center gap-2 rounded-full px-2.5 ring-1 ring-inset focus-within:ring-2">
      <SearchIcon size={12} className="text-text-faint shrink-0" />
      <input
        type="search"
        aria-label="Filter traces by route, service, status or duration"
        data-testid="traces-filter"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && text !== "") {
            event.stopPropagation();
            setText("");
          }
        }}
        placeholder="route:/invoices* status:error >100ms"
        spellCheck={false}
        className="text-code-inline text-text-default placeholder:text-text-faint min-w-0 flex-1 bg-transparent font-mono outline-none [&::-webkit-search-cancel-button]:hidden"
      />
    </label>
  );
};
