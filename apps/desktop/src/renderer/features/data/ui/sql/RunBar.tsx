/**
 * The SQL tab's run bar (DESIGN.md, Data → SQL tab; Paper D2): the Data Source picker, "Schema
 * loaded 4s ago · 7 tables", Format and Run ⌘↵.
 */
import type { DataSource, DataValue } from "@polaris/protocol";
import {
  Button,
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Kbd,
  LockIcon,
} from "@polaris/ui";
import { useNow } from "../../../../shell/useNow.ts";
import { cellOf, displayOf } from "../../grid/value.ts";
import { cmShortcut } from "../../../editor/cm/keys.ts";
import { schemaLine } from "../../sql/copy.ts";
import type { CatalogState } from "../../sql/useCatalog.ts";

export interface RunBarProps {
  readonly sources: ReadonlyArray<DataSource>;
  readonly source: DataSource | undefined;
  readonly catalog: CatalogState;
  readonly running: boolean;
  /** A re-run's params, bound to `$1`, `$2`… on Run. */
  readonly params: ReadonlyArray<DataValue>;
  readonly onUnbind: () => void;
  /** Why Format last failed, until the text changes. */
  readonly formatProblem: string | null;
  readonly onSource: (name: string) => void;
  readonly onFormat: () => void;
  readonly onRun: () => void;
}

const where = (source: DataSource) => `${source.engine} · ${source.locality}`;

const SchemaStatus = ({ catalog }: { readonly catalog: CatalogState }) => {
  // "4s ago" moves while it shows; the bar is on screen only with the SQL tab open.
  const now = useNow(5_000);

  if (catalog.status === "ready")
    return <span data-testid="data-sql-schema">{schemaLine(catalog.tree, now)}</span>;

  if (catalog.status === "failed")
    return (
      <span data-testid="data-sql-schema">{`Couldn't read the schema: ${catalog.error.message}`}</span>
    );

  return catalog.status === "loading" ? <span>Reading the schema…</span> : null;
};

/** "$1 = c-42 · $2 = overdue": what Run binds, with Unbind to run the text alone. */
const Params = ({
  params,
  onUnbind,
}: {
  readonly params: ReadonlyArray<DataValue>;
  readonly onUnbind: () => void;
}) => {
  const bound = params.map((p, i) => `$${i + 1} = ${displayOf(cellOf(p))}`).join(" · ");

  return (
    <span className="flex min-w-0 shrink items-center gap-1.5">
      <span
        className="text-micro text-text-default min-w-0 truncate font-mono"
        title={bound}
        data-testid="data-sql-params"
      >
        {bound}
      </span>
      <Button variant="ghost" size="sm" onClick={onUnbind} data-testid="data-sql-unbind">
        Unbind
      </Button>
    </span>
  );
};

const PlayGlyph = () => (
  <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
    <path d="M1 1.2v7.6L7.2 5z" fill="currentColor" />
  </svg>
);

export const RunBar = ({
  sources,
  source,
  catalog,
  running,
  params,
  onUnbind,
  formatProblem,
  onSource,
  onFormat,
  onRun,
}: RunBarProps) => (
  <div
    className="border-hairline flex h-12 shrink-0 items-center gap-3 border-b pr-2 pl-2.5"
    data-testid="data-sql-run-bar"
  >
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="border-hairline gap-2 rounded-full border pr-2 pl-3"
          data-testid="data-sql-source"
        >
          <span className="text-label text-text-strong">
            {source?.name ?? "Choose a data source"}
          </span>
          {source === undefined ? null : (
            <span className="text-micro text-text-subtle font-mono">{where(source)}</span>
          )}
          <ChevronDownIcon size={12} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {sources.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => onSource(s.name)}>
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="text-micro text-text-subtle font-mono">{where(s)}</span>
            {s.access === "needs-approval" || s.access === "denied" ? (
              <LockIcon size={12} className="text-text-subtle" aria-label="Agents can't reach it" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
    {params.length === 0 ? null : <Params params={params} onUnbind={onUnbind} />}
    <span className="text-caption text-text-subtle min-w-0 flex-1 truncate">
      {formatProblem === null ? (
        <SchemaStatus catalog={catalog} />
      ) : (
        `Couldn't format: ${formatProblem}`
      )}
    </span>
    <Button variant="ghost" onClick={onFormat} data-testid="data-sql-format">
      Format
    </Button>
    <Button
      variant="secondary"
      className="rounded-full"
      disabled={source === undefined || running}
      onClick={onRun}
      data-testid="data-sql-run"
    >
      <PlayGlyph />
      {running ? "Running…" : "Run"}
      <Kbd variant="plain">{cmShortcut("Mod-Enter")}</Kbd>
    </Button>
  </div>
);
