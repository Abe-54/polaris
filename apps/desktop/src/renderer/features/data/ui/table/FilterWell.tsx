/**
 * The filter well (DESIGN.md, Data: Table tab; Paper D1): `WHERE …` in code-inline with the
 * table's columns completing at the caret. ↵ applies, esc reverts; string literals take the
 * syntax colour through a mirror under a transparent input.
 */
import { cn } from "@polaris/ui";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { type GridColumn, isNumericType } from "../../grid/columns.ts";
import { applyCompletion, complete, type Completions } from "./completion.ts";

const STRING = /('(?:[^']|'')*'?)/;

/** The draft split into string literals and the rest, each keyed by where it starts. */
const parts = (text: string) => {
  let offset = 0;

  return text.split(STRING).map((part) => {
    const start = offset;

    offset += part.length;

    return { start, part, literal: part.startsWith("'") };
  });
};

/** The empty well's example, on this table's own columns: a text one where there is one. */
const example = (columns: ReadonlyArray<GridColumn>) => {
  const column =
    columns.find((c) => /char|text/i.test(c.type) && c.fk == null) ??
    columns.find((c) => !isNumericType(c.type)) ??
    columns[0];

  return column === undefined ? "" : `${column.name} = '…'`;
};

const Mirror = ({ text }: { readonly text: string }) => (
  <>
    {parts(text).map(({ start, part, literal }) => (
      <span key={start} className={literal ? "text-syntax-string" : undefined}>
        {part}
      </span>
    ))}
  </>
);

interface Open {
  readonly at: Completions;
  readonly index: number;
}

export interface FilterWellProps {
  readonly columns: ReadonlyArray<GridColumn>;
  /** The applied filter. */
  readonly value: string;
  readonly onApply: (filter: string) => void;
}

export const FilterWell = ({ columns, value, onApply }: FilterWellProps) => {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState<Open | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const mirror = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(value), [value]);

  const suggest = (text: string, caret: number) => {
    const at = complete(text, caret, columns);

    setOpen(at === null ? null : { at, index: 0 });
  };

  const accept = (label: string) => {
    if (open === null) return;
    const next = applyCompletion(draft, open.at, label);

    setDraft(next.text);
    setOpen(null);
    requestAnimationFrame(() => input.current?.setSelectionRange(next.caret, next.caret));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const items = open?.at.items ?? [];

    if (open !== null && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;

      setOpen({ ...open, index: (open.index + step + items.length) % items.length });
    } else if (open !== null && (event.key === "Tab" || event.key === "Enter")) {
      event.preventDefault();
      accept(items[open.index]?.label ?? "");
    } else if (event.key === "Enter") {
      event.preventDefault();
      onApply(draft);
    } else if (event.key === "Escape") {
      event.preventDefault();

      if (open === null) setDraft(value);
      setOpen(null);
    }
  };

  const pending = draft.trim() !== value.trim();

  return (
    <div className="relative min-w-0 flex-1">
      <label
        data-testid="data-filter"
        className="bg-well flex h-8 min-w-0 items-center gap-2 rounded-[10px] px-3 shadow-[inset_0_0_0_1px_var(--color-hairline)] focus-within:shadow-[inset_0_0_0_1px_var(--color-starlight)]"
      >
        <span className="text-text-faint shrink-0 font-mono text-[11px] leading-[14px] font-medium tracking-[0.06em]">
          WHERE
        </span>
        <span className="text-body relative min-w-0 flex-1 font-mono">
          <div
            ref={mirror}
            aria-hidden
            className="text-text-default pointer-events-none absolute inset-0 overflow-hidden whitespace-pre"
          >
            {draft === "" ? (
              <span className="text-text-faint">{example(columns)}</span>
            ) : (
              <Mirror text={draft} />
            )}
          </div>
          <input
            ref={input}
            value={draft}
            spellCheck={false}
            autoComplete="off"
            aria-label="Filter rows"
            aria-autocomplete="list"
            aria-expanded={open !== null}
            aria-controls="data-filter-completions"
            onChange={(event) => {
              setDraft(event.target.value);
              suggest(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onScroll={(event) => {
              if (mirror.current !== null)
                mirror.current.scrollLeft = event.currentTarget.scrollLeft;
            }}
            onKeyDown={onKeyDown}
            onBlur={() => setOpen(null)}
            className="caret-text-strong selection:bg-starlight/30 relative w-full bg-transparent text-transparent outline-none [font-variant-ligatures:none]"
          />
        </span>
        {pending ? (
          <span className="text-text-faint shrink-0 font-mono text-[11px] leading-[14px]">
            ↵ to filter
          </span>
        ) : null}
      </label>
      {open === null ? null : (
        <div
          id="data-filter-completions"
          role="listbox"
          aria-label="Columns"
          data-surface="raised"
          className="rounded-row border-hairline bg-raised shadow-float absolute top-[calc(100%+4px)] left-12 z-30 w-[280px] overflow-hidden border p-1"
        >
          {open.at.items.map((item, at) => (
            <div
              key={item.label}
              role="option"
              aria-selected={at === open.index}
              data-testid="data-filter-completion"
              onMouseDown={(event) => {
                event.preventDefault();
                accept(item.label);
              }}
              className={cn(
                "flex h-7 cursor-default items-center gap-3 rounded-[6px] px-2",
                at === open.index ? "bg-fill-selected" : "hover:bg-fill-hover"
              )}
            >
              <span className="text-code-inline text-text-strong min-w-0 flex-1 truncate font-mono">
                {item.label}
              </span>
              <span className="text-text-subtle shrink-0 font-mono text-[11px] leading-[14px]">
                {item.detail}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
