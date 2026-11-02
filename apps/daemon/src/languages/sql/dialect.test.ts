import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as P from "@polaris/protocol";
import { detectDialect, dialectHint } from "./detection.ts";
import { managedSqlShellSettings } from "./settings.ts";
import { shellFormatting } from "./shellFormatting.ts";
import { createSqlSelection, sqlScope } from "./selection.ts";
import { tempDir } from "../../platform/tempDir.testing.ts";

async function fixture() {
  const root = tempDir("polaris-sql-dialect-", { short: true });
  const path = join(root, "query.sql");
  await writeFile(path, "select 1;");

  const checkout = P.LanguageCheckout.cases.Workspace.make({
    workspaceId: P.WorkspaceId.make("fixture"),
    path: root,
  });

  return { root, path, checkout };
}

test("SQL hints and filename detection use only supported dialects", () => {
  expect(dialectHint("-- polaris-sql-dialect: sqlite\nselect 1;", "a.mysql.sql")).toEqual({
    dialect: "sqlite",
    source: "hint",
  });
  expect(dialectHint("", "a.postgres.sql")).toEqual({ dialect: "postgresql", source: "filename" });
  expect(dialectHint("-- polaris-sql-dialect: unknown", "a.sql")).toBeNull();
});

test("bounded Prisma metadata detection ignores comments and detects each datasource", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "prisma"));

  for (const dialect of ["postgresql", "mysql", "sqlite"] as const) {
    await writeFile(
      join(f.root, "prisma/schema.prisma"),
      `// datasource bad { provider = "mysql" }\ndatasource db { provider = "${dialect}" }`
    );
    expect(await detectDialect(f.root, f.path)).toEqual({ dialect, source: "prisma" });
  }

  await writeFile(
    join(f.root, "prisma/schema.prisma"),
    'datasource a { provider = "sqlite" }\ndatasource b { provider = "mysql" }'
  );
  expect(await detectDialect(f.root, f.path)).toEqual({ dialect: "generic", source: "default" });
});

test("Host SQL overrides persist, clear, inherit Worktrees and reject concurrent stale revisions", async () => {
  const f = await fixture();
  const directory = join(f.root, "ledger");
  const selection = createSqlSelection(directory);
  const current = async () => {};

  const workspace = await selection.select(
    f.checkout,
    f.root,
    f.path,
    "workspace",
    "mysql",
    0,
    current
  );

  expect(workspace.workspace).toBe("mysql");

  const choices = await Promise.allSettled([
    selection.select(f.checkout, f.root, f.path, "file", "sqlite", 1, current),
    selection.select(f.checkout, f.root, f.path, "file", "postgresql", 1, current),
  ]);

  expect(choices.map((x) => x.status)).toEqual(["fulfilled", "rejected"]);
  const restarted = createSqlSelection(directory);
  expect((await restarted.read(f.checkout)).files["query.sql"]).toBe("sqlite");

  const worktree = P.LanguageCheckout.cases.Worktree.make({
    workspaceId: f.checkout.workspaceId,
    path: f.root,
    worktreeId: P.WorktreeId.make("tree"),
  });

  expect((await restarted.read(worktree)).workspace).toBe("mysql");

  const review = P.LanguageCheckout.cases.ReviewCheckout.make({
    workspaceId: f.checkout.workspaceId,
    reviewCheckoutId: P.ReviewCheckoutId.make("review"),
    path: f.root,
  });

  expect(sqlScope(review)).not.toBe(sqlScope(f.checkout));
  expect((await restarted.read(review)).revision).toBe(0);
  expect(
    (await restarted.select(f.checkout, f.root, f.path, "file", null, 2, current)).files
  ).toEqual({});
  await Promise.resolve(
    expect(
      restarted.select(f.checkout, f.root, f.path, "workspace", "sqlite", 3, async () => {
        throw new Error("Disconnected");
      })
    ).rejects.toThrow("Disconnected")
  );
  expect((await restarted.read(f.checkout)).revision).toBe(3);
});

test("only Bash's exact whole-document sentinel is normalized to fenced UTF-16 text", () => {
  const edit = P.LanguageTextEdit.make({
    range: { start: { line: 0, character: 0 }, end: { line: 2147483647, character: 2147483647 } },
    newText: "formatted",
  });

  expect(shellFormatting("bash-language-server", "hi\r\n😀", [edit])[0]?.range.end).toEqual({
    line: 1,
    character: 2,
  });
  expect(shellFormatting("other", "hi", [edit])).toEqual([edit]);

  const invalid = P.LanguageTextEdit.make({
    ...edit,
    range: { ...edit.range, end: { line: 90, character: 90 } },
  });

  expect(shellFormatting("bash-language-server", "hi", [invalid])).toEqual([invalid]);
});

test("managed configuration uses only observed companion paths and disables SQL configuration", () => {
  const launch = {
    initializationOptions: {
      shellcheckPath: "/bounded/shellcheck",
      shfmt: { path: "/managed/shfmt" },
    },
  };

  expect(
    managedSqlShellSettings({ managedSqlShell: true, providerId: "bash-language-server" }, launch)
  ).toEqual({ bashIde: launch.initializationOptions });
  expect(
    managedSqlShellSettings(
      { managedSqlShell: true, providerId: "sqllens-language-server" },
      launch
    )
  ).toEqual({});
  expect(
    managedSqlShellSettings({ managedSqlShell: false, providerId: "bash-language-server" }, launch)
  ).toBeNull();
});
