import "../../../../test/dom.testing.ts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { TableDetail } from "@polaris/protocol";
import { fixtureTable } from "../../preview/fixtures.ts";
import { Structure } from "./Structure.tsx";

afterEach(cleanup);

type Run = readonly [text: string, colour: string | null];

/** The wanted runs an element lacks: a run is a leaf span's text and its syntax colour, if any. */
const missing = (el: HTMLElement | undefined, want: ReadonlyArray<Run>) => {
  const runs = Array.from(el?.querySelectorAll("span") ?? [])
    .filter((s) => s.children.length === 0)
    .map((s) => `${s.textContent?.trim()}:${/text-syntax-(\w+)/.exec(s.className)?.[1] ?? null}`);

  return want.filter(([text, colour]) => !runs.includes(`${text}:${colour}`));
};

test("index and constraint definitions read as coloured SQL; types and keywords are coloured", () => {
  const detail = fixtureTable("invoices");

  if (detail === null) throw new Error("No invoices fixture");
  render(
    <Structure
      detail={
        new TableDetail({
          schema: detail.schema,
          name: detail.name,
          columns: detail.columns,
          constraints: detail.constraints,
          rowEstimate: null,
          indexes: [
            {
              name: "by_status",
              columns: ["status"],
              unique: true,
              definition: "CREATE INDEX by_status ON invoices(status) WHERE status = 'open'",
            },
          ],
        })
      }
      onOpenTable={() => undefined}
    />
  );

  const index = within(screen.getByRole("table", { name: "Indexes" })).getAllByRole("cell")[2];

  const constraint = within(screen.getByRole("table", { name: "Constraints" })).getAllByRole(
    "row"
  )[0];

  const column = within(screen.getByRole("table", { name: "Columns" })).getAllByRole("row")[0];

  expect([
    missing(index, [
      ["unique", "keyword"],
      ["CREATE", "keyword"],
      ["INDEX", "keyword"],
      ["by_status", null],
      ["'open'", "string"],
    ]),
    missing(constraint, [
      ["foreign key", "keyword"],
      ["FOREIGN", "keyword"],
      ["REFERENCES", "keyword"],
    ]),
    missing(column, [
      ["uuid", "type"],
      ["not null", "keyword"],
      ["primary key", "keyword"],
    ]),
  ]).toEqual([[], [], []]);
});
