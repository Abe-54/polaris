/**
 * "SQL: Select dialect…", the popover's Dialect row and missing ShellCheck in the real app:
 * node apps/desktop/scripts/sqlDialectSmoke.ts (build first). Prerequisite probes look in an
 * empty root, so ShellCheck is missing whatever this Mac has installed.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  sizeWindow,
  stockElectronBinary,
} from "./lib/electron.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-sql-dialect-")));

const userData = join(home, "user-data");

const project = join(home, "project");

const probeRoot = join(home, "empty-probes");

const evidence = join(REPO_ROOT, ".dagr/evidence/slice-7b-ui");

for (const path of [userData, project, probeRoot, evidence]) mkdirSync(path, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

writeFileSync(join(project, "package.json"), "{}");

writeFileSync(join(project, "app.postgres.sql"), "select id, name from users where id = 1;\n");

writeFileSync(join(project, "script.sh"), "#!/bin/bash\necho $value\n");

const until = async (what: string, check: () => Promise<boolean>, ms = 60_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${what}`);
};

const appearance = async (page: Page, theme: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "balanced" } })`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(300);
};

const open = async (page: Page, name: string, kind: string) => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+P");
  await page.getByTestId("finder-input").fill(name);
  await page.getByTestId("finder-item").first().waitFor({ timeout: 20_000 });
  await page.keyboard.press("Enter");
  await page
    .locator(`[data-testid="editor-tab"][aria-selected="true"][title$="${name}"]`)
    .waitFor();
  await page
    .locator(`[data-testid="language-pill"][data-kind="${kind}"]`)
    .waitFor({ timeout: 180_000 });
};

const popover = async (page: Page) => {
  if ((await page.getByTestId("language-popover").count()) === 0)
    await page.getByTestId("language-pill").click();

  const body = page.getByTestId("language-popover");

  await body.waitFor({ timeout: 10_000 });

  return body;
};

const dialectRow = async (page: Page) => {
  const row = (await popover(page)).getByText("Dialect", { exact: true });

  await row.waitFor({ timeout: 20_000 });

  return (await row.locator("..").textContent()) ?? "";
};

const closePopover = async (page: Page) => {
  await page.keyboard.press("Escape");
  await page.getByTestId("language-popover").waitFor({ state: "detached" });
};

const ask = async (page: Page) => {
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Meta+Shift+P");
  await page.getByTestId("palette-input").fill("select dialect");

  const command = page
    .locator('[data-testid="palette-row"][data-selected="true"]')
    .filter({ hasText: "SQL: Select dialect…" });

  await command.waitFor({ timeout: 10_000 });

  return command;
};

const choice = (page: Page, title: string) =>
  page.getByTestId("palette-row").filter({ hasText: title });

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  daemon = await startDaemon({
    home,
    benchHarness: true,
    env: { POLARIS_LANGUAGE_PYTHON_PROBE_ROOT: probeRoot },
  });
  app = await electron.launch({
    executablePath: stockElectronBinary(),
    args: [APP_DIR],
    env: {
      ...process.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: "1",
    },
  });

  const page = await app.firstWindow();

  await sizeWindow(app, 1280, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", {hostKey: "local", commandId: crypto.randomUUID(), command: {_tag: "RegisterWorkspace", path: ${JSON.stringify(project)}, name: "sql-dialect-proof"}})`
  );
  await page
    .getByRole("button", { name: /sql-dialect-proof/ })
    .first()
    .click();
  await page.keyboard.press("Meta+3");
  await open(page, "app.postgres.sql", "ready");
  console.log("SQL ready");

  // The popover's row: PostgreSQL, from the file name.
  assert.match(await dialectRow(page), /PostgreSQL.*from the file name/);

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await page.screenshot({ path: join(evidence, `popover-dialect-${theme}.png`) });
  }

  await closePopover(page);
  console.log("Popover: Dialect PostgreSQL, from the file name");

  // The palette lists it with what runs now, then asks.
  await appearance(page, "dark");

  const command = await ask(page);

  assert.match((await command.textContent()) ?? "", /PostgreSQL · from the file name/);
  await page.screenshot({ path: join(evidence, "palette-command-dark.png") });
  await page.keyboard.press("Enter");
  await choice(page, "Use automatic detection").waitFor({ timeout: 20_000 });

  const rows = await page.getByTestId("palette-row").allTextContents();

  assert.deepEqual(
    rows.map(
      (row) => /^(PostgreSQL|MySQL|SQLite|Generic SQL|Use automatic detection)/.exec(row)?.[1]
    ),
    ["PostgreSQL", "MySQL", "SQLite", "Generic SQL", "Use automatic detection"]
  );
  assert.match(rows[0] ?? "", /In use · from the file name/);
  assert.match(rows[3] ?? "", /Formatting only/);

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await page.screenshot({ path: join(evidence, `palette-dialects-${theme}.png`) });
  }

  console.log("Follow-up: four dialects, PostgreSQL in use, then automatic");

  // Choose Generic SQL for this file: the row says so, the server comes back, nothing overpromises.
  await choice(page, "Generic SQL").first().click();
  await page.getByTestId("command-palette").waitFor({ state: "detached" });

  await until("Generic SQL chosen", async () =>
    /Generic SQL.*chosen for this file/.test(await dialectRow(page))
  );
  await page
    .locator('[data-testid="language-pill"][data-kind="ready"]')
    .waitFor({ timeout: 120_000 });
  assert.match((await (await popover(page)).textContent()) ?? "", /Formatting works\. Generic SQL/);
  await page.screenshot({ path: join(evidence, "popover-chosen-light.png") });
  await closePopover(page);
  console.log("Chose Generic SQL for this file; ready, and it promises formatting only");

  // Back to automatic detection.
  await appearance(page, "dark");
  await (await ask(page)).press("Enter");

  const auto = choice(page, "Use automatic detection");

  await auto.waitFor({ timeout: 20_000 });
  assert.match((await auto.textContent()) ?? "", /From a polaris-sql-dialect comment/);
  await page.screenshot({ path: join(evidence, "palette-override-dark.png") });
  await auto.click();
  await until("automatic again", async () =>
    /PostgreSQL.*from the file name/.test(await dialectRow(page))
  );
  await closePopover(page);
  console.log("Use automatic detection returned to PostgreSQL from the file name");

  // Missing ShellCheck: the Shell popover names it once and gives the command.
  await open(page, "script.sh", "prerequisite");

  const shell = await popover(page);

  await shell.getByText("brew install shellcheck", { exact: true }).waitFor({ timeout: 30_000 });

  const text = (await shell.textContent()) ?? "";

  assert.match(text, /Shell needs shellcheck/);
  assert.equal(text.match(/Polaris/g)?.length, 1, "the reason says Polaris's part once");

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await page.screenshot({ path: join(evidence, `shellcheck-missing-${theme}.png`) });
  }

  console.log("Shell: needs shellcheck, brew install shellcheck, reason said once");
  console.log("PASS: SQL dialect and ShellCheck acceptance");
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
}
