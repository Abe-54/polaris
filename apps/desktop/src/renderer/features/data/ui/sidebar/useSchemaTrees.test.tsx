import "../../../../test/dom.testing.ts";
import { DataSource, SchemaTree } from "@polaris/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test } from "bun:test";
import { Schema } from "effect";
import type { ReactNode } from "react";
import type { DataApi } from "../../data/api.ts";
import { DataLayer } from "../../data/hooks.tsx";
import { refreshSources } from "../../model/refresh.ts";
import { fixtureDataApi } from "../../preview/fixtureApi.ts";
import { FIXTURE_SOURCES } from "../../preview/fixtures.ts";
import { DATA_AT } from "../../preview/scene.ts";
import { refreshTime } from "../data.testing.tsx";
import { useSchemaTrees } from "./useSchemaTrees.ts";

const app = FIXTURE_SOURCES[0] ?? FIXTURE_SOURCES.at(0);

if (app === undefined) throw new Error("No app fixture");

const fields = Schema.encodeSync(DataSource);

const schemaWith = (table: string) =>
  new SchemaTree({
    loadedAt: new Date(0).toISOString(),
    schemas: [
      {
        name: "public",
        tables: [{ name: table, rowEstimate: null, columnCount: 0, columns: [] }],
        views: [],
        functions: [],
      },
    ],
    truncatedTables: 0,
  });

/** A describe that serves `answers` in turn (the last one after), and counts its calls; "fail" fails. */
const describing = (answers: ReadonlyArray<string>) => {
  const calls: Array<string> = [];

  const api: DataApi = {
    ...fixtureDataApi(),
    describe: async (_at, { source }) => {
      const answer = answers[Math.min(calls.length, answers.length - 1)] ?? "fail";

      calls.push(source);

      return answer === "fail"
        ? { ok: false, error: { code: "E-DATA-TIMEOUT", message: "timed out" } }
        : { ok: true, value: schemaWith(answer) };
    },
  };

  return { api, calls };
};

const tablesOf = (trees: ReadonlyMap<string, { status: string; value?: SchemaTree }>) => {
  const tree = trees.get("app");

  return tree?.status === "ready"
    ? tree.value?.schemas[0]?.tables.map((t) => t.name)
    : tree?.status;
};

const mount = (api: DataApi, sources: ReadonlyArray<DataSource>) => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DataLayer api={api}>{children}</DataLayer>
  );

  return renderHook(({ list }) => useSchemaTrees(DATA_AT, list, { retryMs: () => 1 }), {
    wrapper,
    initialProps: { list: sources },
  });
};

const refresh = () => act(() => refreshSources(DATA_AT, refreshTime()));

test("a sources refresh reads the open schema again: a table an agent added shows up", async () => {
  const { api, calls } = describing(["invoices", "new_table_after_relist"]);
  const { result } = mount(api, [app]);

  await waitFor(() => expect(tablesOf(result.current)).toEqual(["invoices"]));
  refresh();

  await waitFor(() => expect(tablesOf(result.current)).toEqual(["new_table_after_relist"]));
  expect(calls).toEqual(["app", "app"]);
});

test("the same source pointed at another database is read again; a fresh copy isn't", async () => {
  const { api, calls } = describing(["local_tables", "staging_tables"]);
  const { result, rerender } = mount(api, [app]);

  await waitFor(() => expect(tablesOf(result.current)).toEqual(["local_tables"]));
  rerender({ list: [new DataSource(fields(app))] });
  expect(calls).toHaveLength(1);

  rerender({
    list: [new DataSource({ ...fields(app), host: "staging.internal", database: "ledger" })],
  });
  await waitFor(() => expect(tablesOf(result.current)).toEqual(["staging_tables"]));
  expect(calls).toHaveLength(2);
});

test("a failed read is tried again on its own", async () => {
  const { api, calls } = describing(["fail", "invoices"]);
  const { result } = mount(api, [app]);

  await waitFor(() => expect(tablesOf(result.current)).toEqual(["invoices"]));
  expect(calls).toEqual(["app", "app"]);
});

test("retries stop after four, until the next refresh", async () => {
  const { api, calls } = describing(["fail"]);
  const { result } = mount(api, [app]);

  await waitFor(() => expect(calls).toHaveLength(5));
  // Give a fifth retry the time it would take, with the 1ms backoff.
  await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
  expect([calls.length, tablesOf(result.current)]).toEqual([5, "failed"]);
  refresh();
  await waitFor(() => expect(calls).toHaveLength(6));
});
