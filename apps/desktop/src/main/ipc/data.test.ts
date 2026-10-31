import { expect, test } from "bun:test";
import { DataError, Unsupported, NotFound } from "@polaris/protocol";
import { toDataIpcError } from "./data.ts";

test("F3: Data IPC retains the renderer's error code and fix and scrubs both text fields", () => {
  expect(
    toDataIpcError(
      new DataError({
        code: "E-DATA-TIMEOUT",
        message: "statement timeout",
        fix: "narrow the query",
      })
    )
  ).toEqual({ code: "E-DATA-TIMEOUT", message: "statement timeout", fix: "narrow the query" });
  expect(
    toDataIpcError(
      new DataError({
        code: "E-DATA-SQL",
        message: "password=hunter2",
        fix: "postgres://a:hunter2@db",
      })
    )
  ).toEqual({
    code: "E-DATA-SQL",
    message: "password=[redacted]",
    fix: "postgres://[redacted]@db",
  });
});

test("F3/F12: unsupported Data names an upgrade and ordinary Host failures retain their code", () => {
  expect(toDataIpcError(new Unsupported({ capability: "data" }))).toEqual({
    code: "Unsupported",
    message: "Data is unavailable on this Host. Upgrade the Daemon to use Data.",
  });
  expect(toDataIpcError(new NotFound({ what: "Host", id: "offline" }))).toEqual({
    code: "NotFound",
    message: "",
  });
});

test("SQL error positions survive IPC without relying on message text", () => {
  expect(
    toDataIpcError(
      new DataError({
        code: "E-DATA-SQL",
        message: "syntax error",
        fix: "edit SQL",
        position: 12,
        sqlLine: 3,
      })
    )
  ).toEqual({
    code: "E-DATA-SQL",
    message: "syntax error",
    fix: "edit SQL",
    position: 12,
    line: 3,
  });
});
