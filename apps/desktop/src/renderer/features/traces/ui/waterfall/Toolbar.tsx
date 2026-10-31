/**
 * The waterfall's toolbar (DESIGN.md, Traces → Waterfall; Paper T1/T6): the `Waterfall | Table`
 * switch, Find spans, the Services chip, "Collapse all" (Waterfall only) and "Errors only".
 */
import { cn, SearchIcon, SegmentedControl } from "@polaris/ui";
import type { ReactNode } from "react";
import { ServicesChip } from "./ServicesChip.tsx";
import type { TraceView } from "./useTraceView.ts";

export type MainView = "waterfall" | "table";

const Toggle = ({
  pressed,
  onClick,
  testId,
  children,
}: {
  readonly pressed?: boolean;
  readonly onClick: () => void;
  readonly testId: string;
  readonly children: ReactNode;
}) => (
  <button
    type="button"
    aria-pressed={pressed}
    data-testid={testId}
    onClick={onClick}
    className={cn(
      "text-caption hover:text-text-default focus-visible:ring-starlight flex h-7 shrink-0 cursor-default items-center rounded-full px-2.5 whitespace-nowrap outline-none focus-visible:ring-2",
      pressed === true ? "bg-fill-selected text-text-strong" : "text-text-subtle"
    )}
  >
    {children}
  </button>
);

export const Toolbar = ({
  view,
  onView,
  trace,
}: {
  readonly view: MainView;
  readonly onView: (view: MainView) => void;
  readonly trace: TraceView;
}) => {
  const { focus, setFocus } = trace;

  return (
    <div
      className="flex h-11 shrink-0 items-center gap-2.5 pr-3 pl-4"
      data-testid="waterfall-toolbar"
    >
      <SegmentedControl<MainView>
        aria-label="Waterfall or table"
        variant="well"
        value={view}
        onValueChange={onView}
        options={[
          { value: "waterfall", label: "Waterfall" },
          { value: "table", label: "Table" },
        ]}
      />
      <label className="bg-well ring-hairline focus-within:ring-starlight flex h-7 w-[170px] min-w-0 shrink items-center gap-2 rounded-full px-2.5 ring-1 ring-inset focus-within:ring-2">
        <SearchIcon size={12} className="text-text-faint shrink-0" />
        <input
          type="search"
          aria-label="Find spans by name, service or id"
          data-testid="waterfall-find"
          placeholder="Find spans"
          spellCheck={false}
          value={focus.find}
          onChange={(event) => setFocus({ ...focus, find: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape" && focus.find !== "") {
              event.stopPropagation();
              setFocus({ ...focus, find: "" });
            }
          }}
          className="text-caption text-text-default placeholder:text-text-faint min-w-0 flex-1 bg-transparent outline-none [&::-webkit-search-cancel-button]:hidden"
        />
      </label>
      <span className="flex-1" />
      <ServicesChip
        services={trace.times.services}
        only={focus.service}
        onOnly={(service) => setFocus({ ...focus, service })}
        onHover={trace.setHovered}
      />
      {view === "waterfall" ? (
        <Toggle testId="waterfall-collapse-all" onClick={trace.toggleAll}>
          {trace.allCollapsed ? "Expand all" : "Collapse all"}
        </Toggle>
      ) : null}
      <Toggle
        testId="waterfall-errors-only"
        pressed={focus.errorsOnly}
        onClick={() => setFocus({ ...focus, errorsOnly: !focus.errorsOnly })}
      >
        Errors only
      </Toggle>
    </div>
  );
};
