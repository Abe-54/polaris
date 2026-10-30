import { describe, expect, test } from "bun:test";
import { CompletionContext, type CompletionSource } from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { FIXTURE_SCHEMA, fixtureTable } from "../preview/fixtures.ts";
import { catalogDetailKey, catalogOf, shortCount } from "./catalog.ts";
import { type Engine, formatSql, sqlLanguage } from "./language.ts";

const details = new Map(
  FIXTURE_SCHEMA.schemas[0]?.tables.flatMap((t) => {
    const detail = fixtureTable(t.name);

    return detail === null ? [] : [[catalogDetailKey("public", t.name), detail] as const];
  })
);

const catalog = catalogOf(FIXTURE_SCHEMA, details);

/** What completion offers with the cursor at `|`, through lang-sql's own sources. */
const complete = async (marked: string, engine: Engine = "postgres", from = catalog) => {
  const at = marked.indexOf("|");
  const doc = marked.replace("|", "");
  const state = EditorState.create({ doc, extensions: sqlLanguage(engine, from) });

  ensureSyntaxTree(state, doc.length, 5000);

  const context = new CompletionContext(state, at, true);
  const sources = state.languageDataAt<CompletionSource>("autocomplete", at);
  const results = await Promise.all(sources.map(async (source) => source(context)));

  return results.flatMap((r) => r?.options ?? []);
};

describe("SQL tab completion from the loaded schema", () => {
  test("tables complete after from, with their row estimate", async () => {
    const invoices = (await complete("select * from inv|")).find((o) => o.label === "invoices");

    expect(invoices?.detail).toBe("1.3k rows · 8 columns");
  });

  test("an alias completes its table's columns, with type and foreign key target", async () => {
    const options = await complete(
      "select c.name from invoices i join customers c on c.id = i.customer_id where i.|"
    );

    const byLabel = new Map(options.map((o) => [o.label, o]));

    expect(byLabel.get("currency")?.detail).toBe("char(3) → currencies.code");
    expect(byLabel.get("customer_id")?.detail).toBe("uuid → customers.id");
    expect(byLabel.get("paid_at")?.detail).toBe("timestamptz · nullable");
    expect(byLabel.get("currency")?.info).toBe("invoices.currency · 1.3k rows");
    // customers' columns don't leak into invoices' alias.
    expect(byLabel.has("email")).toBe(false);
  });

  test("a schema-qualified table completes its columns", async () => {
    const labels = (await complete("select public.currencies.| from public.currencies")).map(
      (o) => o.label
    );

    expect(labels.filter((l) => ["code", "name", "minor_units"].includes(l)).sort()).toEqual([
      "code",
      "minor_units",
      "name",
    ]);
  });

  test("a table whose detail isn't read yet still completes, without columns", async () => {
    const options = await complete("select * from pay|", "postgres", catalogOf(FIXTURE_SCHEMA));

    expect(options.find((o) => o.label === "payments")?.detail).toBe("962 rows");
  });
});

describe("row estimates", () => {
  test.each([
    [0, "0"],
    [962, "962"],
    [1312, "1.3k"],
    [2000, "2k"],
    [214_000, "214k"],
    [2_140_000, "2.1M"],
  ])("%d reads %s", (n, text) => {
    expect(shortCount(n)).toBe(text);
  });
});

describe("Format", () => {
  test("lays the query out in the source's dialect", async () => {
    const formatted = await formatSql("select a,b from t where a=1", "postgres");

    expect(formatted).toEqual({ ok: true, text: "select\n  a,\n  b\nfrom\n  t\nwhere\n  a = 1" });
  });

  test("MySQL's backtick identifiers survive; PostgreSQL's dialect refuses them", async () => {
    const sql = "select `total` from `invoices`";

    expect(await formatSql(sql, "mysql")).toEqual({
      ok: true,
      text: "select\n  `total`\nfrom\n  `invoices`",
    });
    expect((await formatSql(sql, "postgres")).ok).toBe(false);
  });
});
