import { describe, expect, test } from "bun:test";
import { describeName } from "./TableTab.tsx";

/** The names the Daemon's catalog resolves: Postgres's regclass, MySQL's and SQLite's plain (ENG-729). */
describe("describeName", () => {
  test.each([
    ["postgres", { schema: "Billing", name: "invoices" }, '"Billing"."invoices"'],
    ["mysql", { schema: "shop", name: "orders" }, "orders"],
    ["sqlite", { schema: "main", name: "cdp_tabs" }, "cdp_tabs"],
  ] as const)("%s asks for %o as %s", (engine, ref, name) => {
    expect(describeName(engine, ref)).toBe(name);
  });
});
