import "../../../test/dom.testing.ts";
import type { SchemaSourceDiff } from "@polaris/protocol";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { PrunedNote } from "./copy.ts";
import { DataRow } from "./DataRows.tsx";
import { dataListRows } from "./model.ts";

afterEach(cleanup);

const source = (more: Partial<SchemaSourceDiff> = {}): SchemaSourceDiff => ({
  source: { id: "src-app", name: "app" },
  status: "complete",
  baseline: "turn-start",
  beforeAt: "2026-10-30T12:00:00.000Z",
  afterAt: "2026-10-30T12:01:00.000Z",
  truncated: false,
  tables: [],
  ...more,
});

const list = (sources: ReadonlyArray<SchemaSourceDiff>, pruned: PrunedNote | null = null) =>
  render(
    <div>
      {dataListRows(sources, pruned).map((row) => (
        <DataRow key={row.key} row={row} open={null} onOpen={() => undefined} />
      ))}
    </div>
  );

describe("the files list's Data rows", () => {
  test("a pruned Turn shows the note under a bare Data kicker, not an empty section", () => {
    const view = list([], {
      text: "Schema snapshot no longer kept for this turn",
      short: "Snapshot no longer kept",
    });

    expect(view.getByTestId("review-data-head").textContent).toBe("Data");
    const note = view.getByTestId("review-data-note");

    expect(note.textContent).toBe("Snapshot no longer kept");
    expect(note.getAttribute("title")).toBe("Schema snapshot no longer kept for this turn");
  });

  test("others' changes show on the Schema diff row, with the full sentence on hover", () => {
    const row = list([source({ concurrent: true })]).getByTestId("review-data-schema");

    expect(row.textContent).toContain("+ others");
    expect(row.getAttribute("title")).toBe(
      "Includes changes from other sessions on this database, not only this turn’s"
    );
  });

  test("an unavailable source's row gives the real reason on hover", () => {
    const row = list([
      source({ status: "unavailable", afterAt: null, errorCode: "E-DATA-DENIED" }),
    ]).getByTestId("review-data-schema");

    expect(row.textContent).toContain("unavailable");
    expect(row.getAttribute("title")).toBe(
      "Polaris wasn’t allowed to read this schema at the end of the turn. The data source isn’t approved, or it changed during the turn"
    );
  });
});
