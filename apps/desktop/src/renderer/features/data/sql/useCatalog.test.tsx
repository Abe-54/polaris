import "../../../test/dom.testing.ts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test } from "bun:test";
import { SchemaTree, SessionId, TableDetail, TableSummary } from "@polaris/protocol";
import type { ReactNode } from "react";
import type { DataApi, DescribeInput } from "../data/api.ts";
import { DataLayer } from "../data/hooks.tsx";
import { fixtureDataApi } from "../preview/fixtureApi.ts";
import { reloadSchema, useCatalog } from "./useCatalog.ts";

let sessions = 0;

const summary = (name: string, columns: ReadonlyArray<string>) =>
  new TableSummary({
    name,
    rowEstimate: 10,
    columnCount: columns.length,
    columns: columns.map((c) => ({ name: c, type: "text" })),
  });

const tree = (loadedAt: string, schemas: Record<string, ReadonlyArray<string>>) =>
  new SchemaTree({
    loadedAt,
    schemas: Object.entries(schemas).map(([name, columns]) => ({
      name,
      tables: [summary("invoices", columns)],
      views: [],
      functions: [],
    })),
    truncatedTables: 0,
  });

const detail = (schema: string, columns: ReadonlyArray<string>) =>
  new TableDetail({
    schema,
    name: "invoices",
    columns: columns.map((name) => ({
      name,
      type: "text",
      nullable: false,
      default: null,
      pk: name === "id",
      fk: null,
    })),
    indexes: [],
    constraints: [],
    rowEstimate: 10,
  });

/** A Host whose schema is `columns()` when read; it records each describe. */
const host = (trees: () => SchemaTree, details: (schema: string) => TableDetail) => {
  const calls: Array<string> = [];

  const api: DataApi = {
    ...fixtureDataApi(),
    describe: async (_at, input: DescribeInput) => {
      calls.push(input.table ?? "(tree)");

      return { ok: true, value: input.table === undefined ? trees() : details("public") };
    },
  };

  return { api, calls };
};

const render = (api: DataApi, text: { value: string }) => {
  const at = { hostKey: "local", sessionId: SessionId.make(`s-catalog-${++sessions}`) };

  const wrapper = ({ children }: { children: ReactNode }) => (
    <DataLayer api={api}>{children}</DataLayer>
  );

  const hook = renderHook(() => useCatalog(at, "app", text.value), { wrapper });

  return { at, hook };
};

const columnsOf = (state: ReturnType<typeof useCatalog>) =>
  state.status === "ready"
    ? (state.catalog.tables.find((t) => t.schema === "public")?.columns.map((c) => c.name) ?? [])
    : [];

test("after a migration and a reload, the fresh tree's columns complete, not the old detail (F5)", async () => {
  let migrated = false;

  const { api, calls } = host(
    () =>
      migrated
        ? tree("2026-10-30T18:10:00Z", { public: ["id", "total", "paid_at"] })
        : tree("2026-10-30T18:00:00Z", { public: ["id", "total"] }),
    () => detail("public", migrated ? ["id", "total", "paid_at"] : ["id", "total"])
  );

  const { at, hook } = render(api, { value: "select * from invoices" });

  await waitFor(() => expect(calls).toEqual(["(tree)", "invoices"]));
  await waitFor(() => expect(columnsOf(hook.result.current)).toEqual(["id", "total"]));

  migrated = true;
  act(() => reloadSchema(at, "app"));

  await waitFor(() => expect(columnsOf(hook.result.current)).toContain("paid_at"));
  await waitFor(() => expect(calls).toEqual(["(tree)", "invoices", "(tree)", "invoices"]));
});

test("one table name in two schemas is described once per tree, not on every pause (F9)", async () => {
  const { api, calls } = host(
    () => tree("2026-10-30T18:00:00Z", { billing: ["id"], public: ["id"] }),
    () => detail("public", ["id"])
  );

  const text = { value: "select * from invoices" };
  const { hook } = render(api, text);

  await waitFor(() => expect(calls).toEqual(["(tree)", "invoices"]));

  for (const more of [" where", " where id", " where id = 1", " where id = 12"]) {
    text.value = `select * from invoices${more}`;
    hook.rerender();
    await new Promise((resolve) => setTimeout(resolve, 380));
  }

  expect(calls).toEqual(["(tree)", "invoices"]);
});
