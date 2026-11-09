/** The sidebar's filter well (DESIGN.md, Requests → Sidebar): each tab has its own. */
import { SearchIcon } from "@polaris/ui";

export const FilterWell = ({
  text,
  onText,
  label = "Filter requests by method, name, URL or file",
  placeholder = "Filter requests",
  testId = "requests-filter",
}: {
  readonly text: string;
  readonly onText: (text: string) => void;
  readonly label?: string;
  readonly placeholder?: string;
  readonly testId?: string;
}) => (
  <label className="bg-well ring-hairline focus-within:ring-starlight flex h-[30px] shrink-0 items-center gap-2 rounded-full px-2.5 ring-1 ring-inset focus-within:ring-2">
    <SearchIcon size={12} className="text-text-faint shrink-0" />
    <input
      type="search"
      aria-label={label}
      data-testid={testId}
      value={text}
      onChange={(event) => onText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && text !== "") {
          event.stopPropagation();
          onText("");
        }
      }}
      placeholder={placeholder}
      spellCheck={false}
      className="text-code-inline text-text-default placeholder:text-text-faint min-w-0 flex-1 bg-transparent font-mono outline-none [&::-webkit-search-cancel-button]:hidden"
    />
  </label>
);
