import { describe, expect, test } from "bun:test";
import type { SchemaTableDiff } from "@polaris/protocol";
import { tableLines } from "./lines.ts";

type Column = NonNullable<SchemaTableDiff["columns"][number]["after"]>;

type Constraint = NonNullable<SchemaTableDiff["constraints"][number]["after"]>;

const column = (more: Partial<Column> = {}): Column => ({
  name: "total_cents",
  type: "integer",
  nullable: true,
  default: null,
  pk: false,
  fk: null,
  ...more,
});

const changed = (more: Partial<SchemaTableDiff>): SchemaTableDiff => ({
  kind: "changed",
  before: { schema: "public", name: "invoices" },
  after: { schema: "public", name: "invoices" },
  columns: [],
  indexes: [],
  constraints: [],
  rows: { kind: "unknown", value: null },
  ...more,
});

const lineOf = (table: SchemaTableDiff) =>
  tableLines(table).map((l) => [l.change, l.what, l.name, l.detail]);

describe("a table's column lines", () => {
  test("a changed column says what changed, before → after", () => {
    expect(
      lineOf(
        changed({
          columns: [
            {
              name: "total_cents",
              before: column(),
              after: column({ type: "bigint", nullable: false }),
            },
            { name: "currency", before: null, after: column({ type: "char(3)" }) },
          ],
          indexes: [
            {
              name: "invoices_old_idx",
              before: { name: "invoices_old_idx", columns: ["id"], unique: true, definition: "" },
              after: null,
            },
          ],
        })
      )
    ).toEqual([
      ["changed", "column", "total_cents", "integer → bigint · nullable → not null"],
      ["added", "column", "currency", "char(3)  nullable"],
      ["removed", "index", "invoices_old_idx", "(id) unique"],
    ]);
  });

  test.each([
    [
      { generated: "price * qty" },
      { generated: "price * qty * 2" },
      "generated as price * qty → generated as price * qty * 2",
    ],
    [{}, { generated: "price * qty" }, "not generated → generated as price * qty"],
    [
      { collation: "utf8mb4_general_ci" },
      { collation: "utf8mb4_bin" },
      "collation utf8mb4_general_ci → utf8mb4_bin",
    ],
    [{}, { extra: "on update CURRENT_TIMESTAMP" }, "extra none → on update CURRENT_TIMESTAMP"],
  ] as const)("%o → %o reads %s", (before, after, detail) => {
    const [line] = tableLines(
      changed({ columns: [{ name: "c", before: column(before), after: column(after) }] })
    );

    expect(line?.detail).toBe(detail);
  });

  test("an added column lists its generated expression, collation and extra", () => {
    const [line] = tableLines(
      changed({
        columns: [
          {
            name: "updated_at",
            before: null,
            after: column({
              type: "timestamp",
              collation: "C",
              generated: "now()",
              extra: "on update CURRENT_TIMESTAMP",
            }),
          },
        ],
      })
    );

    expect(line?.detail).toBe(
      "timestamp  nullable  generated as now()  collate C  on update CURRENT_TIMESTAMP"
    );
  });

  test("a fingerprint-only change says 'definition changed'; equal fingerprints say nothing", () => {
    const redacted = (fingerprint: string) => column({ default: "[redacted]", fingerprint });

    const [moved, still] = tableLines(
      changed({
        columns: [
          { name: "a", before: redacted("f1"), after: redacted("f2") },
          { name: "b", before: redacted("f1"), after: { ...redacted("f1"), type: "bigint" } },
        ],
      })
    );

    expect(moved?.detail).toBe("definition changed");
    expect(still?.detail).toBe("integer → bigint");
  });
});

describe("a table's constraint, trigger and view lines", () => {
  const constraint = (kind: string, definition: string, fingerprint?: string): Constraint =>
    fingerprint === undefined
      ? { name: kind, kind, definition }
      : { name: kind, kind, definition, fingerprint };

  test.each([
    ["p", "primary key"],
    ["FOREIGN KEY", "foreign key"],
    ["UNIQUE", "unique"],
    ["c", "check"],
    ["x", "exclusion"],
    ["trigger", "trigger"],
    ["view", "view"],
    ["security", "row security"],
    ["something new", "constraint"],
  ])("kind %s reads as %s", (kind, word) => {
    const [line] = tableLines(
      changed({ constraints: [{ name: "n", before: null, after: constraint(kind, "x") }] })
    );

    expect(line?.what).toBe(word);
  });

  test("a short definition reads before → after on its line, with nothing to fold", () => {
    const [line] = tableLines(
      changed({
        constraints: [
          {
            name: "total_positive",
            before: constraint("c", "CHECK (total > 0)"),
            after: constraint("c", "CHECK (total >= 0)"),
          },
        ],
      })
    );

    expect(line?.detail).toBe("CHECK (total > 0) → CHECK (total >= 0)");
    expect(line?.definition).toBeUndefined();
  });

  test("a long trigger definition folds: the line says it changed and keeps both sides", () => {
    const before =
      "CREATE TRIGGER invoices_audit AFTER UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION audit_invoice()";

    const after = before.replace("AFTER UPDATE", "AFTER INSERT OR UPDATE");

    const [line] = tableLines(
      changed({
        constraints: [
          {
            name: "invoices_audit",
            before: constraint("trigger", before),
            after: constraint("trigger", after),
          },
        ],
      })
    );

    expect([line?.what, line?.detail]).toEqual(["trigger", "definition changed"]);
    expect(line?.definition).toEqual({ before, after });
  });

  test("an added multi-line view shows one line and folds the rest", () => {
    const view = " SELECT id,\n    total\n   FROM invoices;";

    const [line] = tableLines(
      changed({ constraints: [{ name: "view", before: null, after: constraint("view", view) }] })
    );

    expect(line?.detail).toBe("SELECT id, total FROM invoices;");
    expect(line?.definition).toEqual({ before: null, after: view });
  });

  test("row security flags read as words", () => {
    const [line] = tableLines(
      changed({
        constraints: [
          {
            name: "row_security",
            before: constraint("security", "false:false"),
            after: constraint("security", "true:true"),
          },
        ],
      })
    );

    expect(line?.detail).toBe("off → on, forced");
  });

  test("a constraint whose redacted definition didn't visibly move says 'definition changed'", () => {
    const [line] = tableLines(
      changed({
        constraints: [
          {
            name: "c",
            before: constraint("c", "CHECK (kind <> [redacted])", "f1"),
            after: constraint("c", "CHECK (kind <> [redacted])", "f2"),
          },
        ],
      })
    );

    expect(line?.detail).toBe("definition changed");
  });
});
