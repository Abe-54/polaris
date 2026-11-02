import { describe, expect, test } from "bun:test";
import type { DataTls } from "@polaris/protocol";
import { parseConnectionString } from "./connectionString.ts";

describe("parseConnectionString", () => {
  test("reads a Postgres URL, percent-decoding the password", () => {
    expect(
      parseConnectionString(
        "postgres://reader:p%40ss%3Aw0rd@db.internal:6543/warehouse?sslmode=require"
      )
    ).toEqual({
      engine: "postgres",
      host: "db.internal",
      port: 6543,
      database: "warehouse",
      user: "reader",
      password: "p@ss:w0rd",
      tls: "require",
    });
  });

  test.each<[string, DataTls | undefined]>([
    ["postgres://u@h/d?sslmode=verify-full", "verify-full"],
    ["postgres://u@h/d?sslmode=prefer", "prefer"],
    ["mysql://u@h/d?ssl-mode=VERIFY_IDENTITY", "verify-full"],
    ["mysql://u@h/d?ssl-mode=REQUIRED", "require"],
    ["postgres://u@h/d?ssl=true", "require"],
    ["postgres://u@h/d?sslmode=disable", undefined],
    ["postgres://u@h/d", undefined],
  ])("%s pastes TLS %s", (text, tls) => {
    const parsed = parseConnectionString(text);

    expect(parsed).toMatchObject({ host: "h" });
    expect(parsed !== undefined && "tls" in parsed ? parsed.tls : undefined).toBe(tls);
  });

  test("an unknown TLS mode isn't filled in as no TLS", () => {
    expect(parseConnectionString("postgres://u@h/d?sslmode=sometimes")).toBeUndefined();
  });

  test("takes an IPv6 host out of its brackets", () => {
    expect(parseConnectionString("postgresql://app@[2001:db8::1]:5433/app")).toMatchObject({
      host: "2001:db8::1",
      port: 5433,
    });
  });

  test("Postgres query parameters override the authority", () => {
    expect(
      parseConnectionString(
        "postgres://ignored:old@ignored:1/ignored?host=/var/run/postgresql&port=5544&user=ops&dbname=metrics&password=n%26w"
      )
    ).toEqual({
      engine: "postgres",
      host: "/var/run/postgresql",
      port: 5544,
      database: "metrics",
      user: "ops",
      password: "n&w",
    });
  });

  test("MySQL ignores Postgres-only parameters and defaults to 3306", () => {
    expect(parseConnectionString("mysql://root:pw@mysql.local/shop?host=elsewhere")).toEqual({
      engine: "mysql",
      host: "mysql.local",
      port: 3306,
      database: "shop",
      user: "root",
      password: "pw",
    });
  });

  test("a bare Postgres URL takes libpq's defaults", () => {
    expect(parseConnectionString("postgres://")).toEqual({
      engine: "postgres",
      host: "localhost",
      port: 5432,
      database: "postgres",
      user: "postgres",
      password: "",
    });
  });

  test.each([
    ["file:///Users/me/app/dev.db", "/Users/me/app/dev.db"],
    ["sqlite:/srv/data/my%20app.sqlite3?mode=ro", "/srv/data/my app.sqlite3"],
    ["file:///C:/data/dev.db", "C:/data/dev.db"],
  ])("reads the SQLite file in %s", (pasted, path) => {
    expect(parseConnectionString(pasted)).toEqual({ engine: "sqlite", path });
  });

  test.each([
    "warehouse.internal",
    "hello world",
    "https://example.com/db",
    "postgres://db:99999/app",
    "postgres://a/b?host=one,two",
    "postgres://db/app?user=a&user=b",
    "postgres://db/%E0%A4%A",
    "file:relative/dev.db",
    "file::memory:",
    "",
  ])("leaves %p as plain text", (pasted) => {
    expect(parseConnectionString(pasted)).toBeUndefined();
  });
});
