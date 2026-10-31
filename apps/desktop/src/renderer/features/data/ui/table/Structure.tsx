/**
 * The Table tab's Structure (DESIGN.md, Data: Table tab): the table's TableDetail as three lists,
 * columns, indexes and constraints, at the density row height. A foreign key opens its table.
 */
import type { TableDetail } from "@polaris/protocol";
import { Kicker } from "@polaris/ui";
import type { ReactNode } from "react";
import type { TableRef } from "./sql.ts";

const Section = ({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly children: ReactNode;
}) => (
  <section className="flex flex-col">
    <Kicker parts={[title, count]} className="px-4 pt-4 pb-2" />
    {count === 0 ? (
      <p className="text-caption text-text-subtle px-4">None</p>
    ) : (
      <div role="table" aria-label={title} className="flex flex-col">
        {children}
      </div>
    )}
  </section>
);

const Row = ({ children }: { readonly children: ReactNode }) => (
  <div
    role="row"
    className="border-hairline text-code-inline flex h-(--spacing-row) items-center gap-4 border-b px-4 font-mono"
  >
    {children}
  </div>
);

const Cell = ({ width, children }: { readonly width?: number; readonly children: ReactNode }) => (
  <span
    role="cell"
    className={width === undefined ? "min-w-0 flex-1 truncate" : "shrink-0 truncate"}
    style={width === undefined ? undefined : { width }}
  >
    {children}
  </span>
);

export const Structure = ({
  detail,
  onOpenTable,
}: {
  readonly detail: TableDetail;
  readonly onOpenTable: (ref: TableRef) => void;
}) => (
  <div data-testid="data-structure" className="min-h-0 flex-1 overflow-auto pb-4">
    <Section title="Columns" count={detail.columns.length}>
      {detail.columns.map((c) => (
        <Row key={c.name}>
          <Cell width={200}>
            <span className="text-text-strong font-medium">{c.name}</span>
          </Cell>
          <Cell width={160}>
            <span className="text-text-subtle">{c.type}</span>
          </Cell>
          <Cell width={80}>
            <span className={c.nullable ? "text-text-subtle" : "text-text-default"}>
              {c.nullable ? "null" : "not null"}
            </span>
          </Cell>
          <Cell>
            {c.pk ? <span className="text-text-default">primary key </span> : null}
            {c.fk === null ? null : (
              <button
                type="button"
                onClick={() => {
                  if (c.fk !== null) onOpenTable({ schema: c.fk.schema, name: c.fk.table });
                }}
                className="text-starlight-text cursor-default hover:underline"
              >
                {c.fk.table}.{c.fk.column} →
              </button>
            )}
            {c.default === null ? null : (
              <span className="text-text-subtle"> default {c.default}</span>
            )}
          </Cell>
        </Row>
      ))}
    </Section>
    <Section title="Indexes" count={detail.indexes.length}>
      {detail.indexes.map((index) => (
        <Row key={index.name}>
          <Cell width={280}>
            <span className="text-text-strong">{index.name}</span>
          </Cell>
          <Cell width={200}>{index.columns.join(", ")}</Cell>
          <Cell>
            <span className="text-text-subtle">
              {index.unique ? "unique · " : ""}
              {index.definition}
            </span>
          </Cell>
        </Row>
      ))}
    </Section>
    <Section title="Constraints" count={detail.constraints.length}>
      {detail.constraints.map((constraint) => (
        <Row key={constraint.name}>
          <Cell width={280}>
            <span className="text-text-strong">{constraint.name}</span>
          </Cell>
          <Cell width={120}>
            <span className="text-text-subtle">{constraint.kind}</span>
          </Cell>
          <Cell>{constraint.definition}</Cell>
        </Row>
      ))}
    </Section>
  </div>
);
