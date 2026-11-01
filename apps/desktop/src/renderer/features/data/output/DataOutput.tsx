/**
 * Output's Data tab for the Turn shown (DESIGN.md, Data → In Orchestrate): writes as before/after
 * cards linked to their approvals, schema changes with "Schema diff", reads folded to one row,
 * and "Open in Data ⌘4" on each. The caller shows the tab only when the Turn touched data.
 */
import type { DataSource, SchemaSourceDiff, SessionId } from "@polaris/protocol";
import { Button, cn, PixelAlertIcon, PixelFailedIcon, PixelHandIcon } from "@polaris/ui";
import type { ReactNode } from "react";
import { useShellActions } from "../../../shell/hooks.ts";
import { countParts, currentName, tableCounts } from "../../review/schema/model.ts";
import { useDataSources } from "../data/hooks.tsx";
import { BeforeAfter } from "../write/BeforeAfter.tsx";
import { OpenInData } from "../write/OpenInData.tsx";
import { SqlStatement } from "../write/SqlStatement.tsx";
import { verbOf } from "../write/model.ts";
import {
  affectedLines,
  readsLine,
  schemaTarget,
  type TurnData,
  type TurnWrite,
  writeStatus,
} from "./model.ts";
import { dataOpeners, type ShownTurn } from "./open.ts";

export interface DataOutputProps {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly data: TurnData;
  /** The Turn's number and its Turns' ids, for the Query log's filter. */
  readonly turn: ShownTurn;
}

const KICKER = "font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase text-text-faint";

const CARD = "rounded-card border-hairline bg-surface-raised flex flex-col gap-2.5 border p-3.5";

const Footer = ({ children }: { readonly children: ReactNode }) => (
  <div className="-mx-1 -mb-1 flex flex-wrap items-center justify-end gap-1">{children}</div>
);

/** Scrolls the conversation to the write's approval card, where it asked. */
const showApproval = (requestId: string) =>
  document
    .querySelector(`[data-approval-id="${CSS.escape(requestId)}"]`)
    ?.scrollIntoView({ block: "center" });

const StatusIcon = ({ kind }: { readonly kind: ReturnType<typeof writeStatus>["kind"] }) => {
  if (kind === "needs-you")
    return <PixelHandIcon size={12} className="text-needs-you shrink-0" aria-hidden />;

  if (kind === "failed")
    return <PixelFailedIcon size={12} className="text-failed shrink-0" aria-hidden />;

  if (kind === "unknown")
    return <PixelAlertIcon size={12} className="text-needs-you shrink-0" aria-hidden />;

  return null;
};

const WriteCard = ({
  item,
  source,
  onOpen,
}: {
  readonly item: TurnWrite;
  readonly source: DataSource | undefined;
  readonly onOpen: () => void;
}) => {
  const { entry, approval } = item;
  const status = writeStatus(item);
  const affected = affectedLines(entry);

  return (
    <article className={CARD} data-testid="data-output-write" data-state={status.kind}>
      <header className="flex min-w-0 items-center gap-2">
        <span className={cn(KICKER, "shrink-0")}>{verbOf(entry.sql)}</span>
        <span className="text-caption text-text-subtle min-w-0 truncate font-mono">
          {source?.name ?? entry.source.name}
        </span>
        <span className="flex-1" />
        <span
          className={cn(
            "text-caption flex min-w-0 items-center gap-1.5",
            status.kind === "needs-you" ? "text-needs-you-text" : "text-text-default"
          )}
        >
          <StatusIcon kind={status.kind} />
          <span className="truncate" title={status.line}>
            {status.line}
          </span>
        </span>
      </header>
      {status.detail === undefined ? null : (
        <p
          className={cn(
            "text-caption [overflow-wrap:anywhere]",
            status.kind === "failed" ? "text-failed-text" : "text-text-subtle"
          )}
        >
          {status.detail}
        </p>
      )}
      <SqlStatement sql={entry.sql} />
      {affected.length === 0 ? null : (
        <p className="text-caption text-text-subtle tabular font-mono">{affected.join(" · ")}</p>
      )}
      {approval === null ? null : <BeforeAfter write={approval.write} className="max-h-[232px]" />}
      <Footer>
        {approval === null ? null : (
          <Button variant="ghost" size="xs" onClick={() => showApproval(approval.request.id)}>
            Approval
          </Button>
        )}
        <OpenInData onOpen={onOpen} />
      </Footer>
    </article>
  );
};

const SchemaCard = ({
  source,
  onSchemaDiff,
  onOpen,
}: {
  readonly source: SchemaSourceDiff;
  readonly onSchemaDiff: () => void;
  readonly onOpen: () => void;
}) => {
  const parts = countParts(tableCounts(source));
  const target = schemaTarget(source);

  return (
    <article className={CARD} data-testid="data-output-schema">
      <header className="flex min-w-0 items-center gap-2">
        <span className={cn(KICKER, "shrink-0")}>Schema</span>
        <span className="text-caption text-text-subtle min-w-0 truncate font-mono">
          {source.source.name}
        </span>
        <span className="flex-1" />
        {source.status === "pending" ? (
          <span className="text-caption text-text-subtle">Capturing schema…</span>
        ) : (
          parts.map((p) => (
            <span
              key={p.kind}
              className={cn(
                "text-code-inline tabular font-mono",
                p.kind === "added" && "text-diff-added-text",
                p.kind === "removed" && "text-diff-removed-text",
                (p.kind === "changed" || p.kind === "renamed") && "text-git-modified-text"
              )}
            >
              {p.text}
            </span>
          ))
        )}
      </header>
      {source.tables.length === 0 ? null : (
        <p className="text-caption text-text-default min-w-0 truncate font-mono">
          {source.tables
            .slice(0, 5)
            .map((t) => currentName(t))
            .join(" · ")}
          {source.tables.length > 5 ? ` · + ${source.tables.length - 5} more` : ""}
        </p>
      )}
      <Footer>
        <Button
          variant="ghost"
          size="xs"
          onClick={onSchemaDiff}
          data-testid="data-output-schema-diff"
        >
          Schema diff
        </Button>
        {target.kind === "removed" ? (
          <span className="text-caption text-text-subtle px-1" data-testid="data-output-removed">
            {`${target.name} was removed`}
          </span>
        ) : (
          <OpenInData onOpen={onOpen} />
        )}
      </Footer>
    </article>
  );
};

export const DataOutput = ({ hostKey, sessionId, data, turn }: DataOutputProps) => {
  const at = { hostKey, sessionId };
  const listed = useDataSources(at);
  const sources = listed.status === "ready" ? listed.value : [];
  const open = dataOpeners(at, sources, useShellActions());

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
      data-testid="data-output"
    >
      {data.writes.map((item) => (
        <WriteCard
          key={item.entry.id}
          item={item}
          source={sources.find((s) => s.id === item.entry.source.id)}
          onOpen={() => open.write(item)}
        />
      ))}
      {data.schema.map((source) => (
        <SchemaCard
          key={source.source.id}
          source={source}
          onSchemaDiff={() => open.schemaDiff(source, turn)}
          onOpen={() => open.schema(source)}
        />
      ))}
      {data.reads.length === 0 ? null : (
        <div
          className="rounded-card border-hairline bg-surface-raised flex items-center gap-2 border py-1.5 pr-1.5 pl-3.5"
          data-testid="data-output-reads"
        >
          <button
            type="button"
            className="text-body text-text-default hover:text-text-strong focus-visible:ring-starlight min-w-0 flex-1 cursor-default truncate rounded-[4px] text-left outline-none focus-visible:ring-2"
            onClick={() => open.log(turn)}
          >
            {readsLine(data.reads.length)}
            <span className="text-text-subtle"> · Query log</span>
          </button>
          <OpenInData onOpen={() => open.log(turn)} />
        </div>
      )}
    </div>
  );
};
