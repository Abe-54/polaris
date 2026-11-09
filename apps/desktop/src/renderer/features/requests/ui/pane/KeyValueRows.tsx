/**
 * Params and Headers: name and value rows in mono, as written with their `{{variables}}`, and a
 * blank row at the end that becomes a new one when typed in.
 */
import { CloseIcon, cn } from "@polaris/ui";

export interface Pair {
  readonly name: string;
  readonly value: string;
}

const FIELD =
  "text-caption text-text-default placeholder:text-text-faint h-7 min-w-0 rounded-control bg-transparent px-2 font-mono outline-none hover:bg-fill-hover focus:bg-well focus:ring-1 focus:ring-starlight";

export const KeyValueRows = ({
  rows,
  label,
  onRows,
}: {
  readonly rows: ReadonlyArray<Pair>;
  /** "Header" or "Parameter", for each field's accessible name. */
  readonly label: string;
  readonly onRows: (rows: ReadonlyArray<Pair>) => void;
}) => {
  const shown = [...rows, { name: "", value: "" }];

  const change = (at: number, pair: Pair) =>
    onRows(at === rows.length ? [...rows, pair] : rows.map((row, i) => (i === at ? pair : row)));

  return (
    <div
      className="px-panel flex flex-col gap-0.5 py-3"
      data-testid={`requests-${label.toLowerCase()}s`}
    >
      {shown.map((row, at) => {
        const blank = at === rows.length;

        return (
          <div key={at} className="group flex items-center gap-2">
            <input
              aria-label={`${label} ${at + 1} name`}
              value={row.name}
              placeholder={blank ? "name" : undefined}
              spellCheck={false}
              onChange={(event) => change(at, { ...row, name: event.target.value })}
              className={cn(FIELD, "w-[200px] shrink-0")}
            />
            <input
              aria-label={`${label} ${at + 1} value`}
              value={row.value}
              placeholder={blank ? "value" : undefined}
              spellCheck={false}
              onChange={(event) => change(at, { ...row, value: event.target.value })}
              className={cn(FIELD, "flex-1")}
            />
            <button
              type="button"
              aria-label={`Remove ${label.toLowerCase()} ${row.name}`}
              disabled={blank}
              onClick={() => onRows(rows.filter((_, i) => i !== at))}
              className="text-text-faint hover:text-text-default focus-visible:ring-starlight flex size-6 shrink-0 cursor-default items-center justify-center rounded-full opacity-0 outline-none group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 disabled:invisible"
            >
              <CloseIcon size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
};
