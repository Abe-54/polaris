import "../../../test/dom.testing.ts";
import {
  type DataSchemaDiff,
  type SchemaSourceDiff,
  type SchemaTableDiff,
  SessionId,
} from "@polaris/protocol";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { TableRef } from "../../data/model/tabs.ts";
import type { ReactNode } from "react";
import { DataLayer } from "../../data/index.ts";
import { fixtureDataApi } from "../../data/preview/fixtureApi.ts";
import { SchemaDiffBody } from "./SchemaDiffBody.tsx";
import { type SchemaDiffQuery, useSchemaDiff } from "./useSchemaDiff.ts";

afterEach(cleanup);

const SESSION = SessionId.make("s-1");

const table = (name: string, rows: SchemaTableDiff["rows"]): SchemaTableDiff => ({
  kind: "changed",
  before: { schema: "public", name },
  after: { schema: "public", name },
  columns: [],
  indexes: [],
  constraints: [],
  rows,
});

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

const body = (s: SchemaSourceDiff) =>
  render(<SchemaDiffBody source={s} scope="Start → end of turn 7" />).getByTestId("schema-diff");

describe("the Schema Diff body", () => {
  test("the rows card says unknown, estimate and exact apart, and never shows unknown as 0", () => {
    const text = body(
      source({
        tables: [
          table("payments", { kind: "unknown", value: null }),
          table("customers", { kind: "estimate", value: 1200 }),
          table("invoices", { kind: "exact", value: 214, agent: 200, user: 14 }),
        ],
      })
    ).querySelector("[data-testid=schema-rows]")?.textContent;

    expect(text).toContain("paymentsRows changed: unknown");
    expect(text).toContain("customers~1,200 rows · estimate");
    expect(text).toContain("invoices214 rows changed · 200 by agents · 14 by you");
    expect(text).not.toMatch(/payments0/);
  });

  test.each([
    [{ status: "pending" as const, afterAt: null }, "Capturing schema…"],
    [
      { status: "unavailable" as const, beforeAt: null },
      "Polaris couldn’t read this schema at the start of the turn",
    ],
    [{ truncated: true }, "Large schema: additions and removals may be incomplete"],
    [{ baseline: "previous-turn-end" as const }, "Since the end of the previous turn"],
    [{ baseline: "first-use" as const }, "Since this source was first used in the turn"],
    [{}, "Start → end of turn 7"],
  ])("%o says %s", (more, words) => {
    expect(body(source(more)).textContent).toContain(words);
  });

  test("Open in Data names the table by its schema and name, not one joined string", () => {
    const opened: Array<TableRef> = [];

    const billing = {
      ...table("invoices", { kind: "exact", value: 1 }),
      after: { schema: "billing", name: "invoices" },
    };

    const view = render(
      <SchemaDiffBody
        source={source({ tables: [billing] })}
        scope="Start → end of turn 7"
        onOpenTable={(ref) => opened.push(ref)}
      />
    );

    fireEvent.click(view.getByRole("button", { name: /Open in Data/ }));
    expect(opened).toEqual([{ schema: "billing", name: "invoices" }]);
  });

  test("folds past 30 tables until asked", () => {
    const tables = Array.from({ length: 214 }, (_, n) =>
      table(`t${n}`, { kind: "exact", value: 1 })
    );

    const view = render(<SchemaDiffBody source={source({ tables })} scope="" />);

    expect(view.getAllByTestId("schema-table")).toHaveLength(30);
    expect(view.getAllByTestId("schema-rows-line")).toHaveLength(30);
    act(() => view.getByText("Show 184 more tables").click());
    expect(view.getAllByTestId("schema-table")).toHaveLength(214);
  });
});

describe("fetching the Schema Diff", () => {
  const DIFF: DataSchemaDiff = { sessionId: SESSION, sources: [source()] };

  const run = (answer: "unsupported" | (() => DataSchemaDiff), query: Partial<SchemaDiffQuery>) => {
    let calls = 0;
    const api = fixtureDataApi({ schemaDiff: answer === "unsupported" ? answer : () => answer() });

    const counted = {
      ...api,
      schemaDiff: (...args: Parameters<typeof api.schemaDiff>) => {
        calls += 1;

        return api.schemaDiff(...args);
      },
    };

    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <DataLayer api={counted}>{children}</DataLayer>
    );

    const hook = renderHook((q: SchemaDiffQuery) => useSchemaDiff(q), {
      wrapper,
      initialProps: {
        hostKey: "local",
        sessionId: SESSION,
        turn: undefined,
        supported: true,
        ended: 1,
        ...query,
      },
    });

    return { hook, calls: () => calls };
  };

  test("a Daemon without data.schemaDiff gets no request and shows nothing", async () => {
    const { hook, calls } = run(() => DIFF, { supported: false });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls()).toBe(0);
    expect(hook.result.current).toBeNull();
  });

  test("an Unsupported answer shows nothing", async () => {
    const { hook, calls } = run("unsupported", {});

    await waitFor(() => expect(calls()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hook.result.current).toBeNull();
  });

  test("fetches on open and again only when a Turn ends", async () => {
    const { hook, calls } = run(() => DIFF, {});

    const props = {
      hostKey: "local",
      sessionId: SESSION,
      turn: undefined,
      supported: true,
      ended: 1,
    };

    await waitFor(() => expect(hook.result.current?.sources).toHaveLength(1));
    hook.rerender(props);
    expect(calls()).toBe(1);
    hook.rerender({ ...props, ended: 2 });
    await waitFor(() => expect(calls()).toBe(2));
  });
});
