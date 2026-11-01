/**
 * "Python: Select interpreter…" and the popover's Interpreter row in the real app, on a uv
 * fixture: node apps/desktop/scripts/pythonInterpreterSmoke.ts (build first; needs uv).
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-python-interpreter-")));

const userData = join(home, "user-data");

const project = join(home, "project");

const evidence = join(REPO_ROOT, ".dagr/evidence/slice-5-ui");

for (const path of [userData, project, evidence]) mkdirSync(path, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

const uv = (args: ReadonlyArray<string>) =>
  execFileSync("uv", [...args, "--no-python-downloads"], { cwd: project, stdio: "pipe" });

uv(["init", "--bare", "--python", "/usr/bin/python3"]);

uv(["venv", "--python", "/usr/bin/python3"]);

uv(["lock", "--offline"]);

const cfg = readFileSync(join(project, ".venv/pyvenv.cfg"), "utf8");

const venvVersion = /version_info\s*=\s*(\d+\.\d+\.\d+)/.exec(cfg)?.[1];

assert.ok(venvVersion, "uv wrote version_info");

writeFileSync(join(project, "proof.py"), "def answer() -> int:\n    return 42\n");

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

const popoverFact = async (page: Page) => {
  if ((await page.getByTestId("language-popover").count()) === 0)
    await page.getByTestId("language-pill").click();
  const row = page.getByTestId("language-popover").getByText("Interpreter", { exact: true });

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
  await page.getByTestId("palette-input").fill("select interpreter");

  const command = page
    .locator('[data-testid="palette-row"][data-selected="true"]')
    .filter({ hasText: "Python: Select interpreter…" });

  await command.waitFor({ timeout: 10_000 });

  return command;
};

const rows = (page: Page) => page.getByTestId("palette-row").allTextContents();

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  daemon = await startDaemon({ home, benchHarness: true });
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
    `window.polaris.request("dispatch", {hostKey: "local", commandId: crypto.randomUUID(), command: {_tag: "RegisterWorkspace", path: ${JSON.stringify(project)}, name: "python-interpreter-proof"}})`
  );
  await page
    .getByRole("button", { name: /python-interpreter-proof/ })
    .first()
    .click();
  await page.keyboard.press("Meta+3");
  await page.keyboard.press("Meta+P");
  await page.getByTestId("finder-input").fill("proof.py");
  await page.getByTestId("finder-item").first().waitFor({ timeout: 20_000 });
  await page.keyboard.press("Enter");
  await page
    .locator('[data-testid="language-pill"][data-kind="ready"]')
    .waitFor({ timeout: 180_000 });
  console.log("Python ready");

  // The popover's row: uv's version, automatically.
  const automatic = await popoverFact(page);

  assert.match(automatic, new RegExp(`${venvVersion.replaceAll(".", "\\.")}.*uv, automatic`));

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await page.screenshot({ path: join(evidence, `popover-automatic-${theme}.png`) });
  }

  await closePopover(page);
  console.log(`Popover: Interpreter ${venvVersion}, uv, automatic`);

  // The palette lists it with what runs now, then asks.
  await appearance(page, "dark");

  const command = await ask(page);

  assert.match((await command.textContent()) ?? "", new RegExp(`uv · ${venvVersion}`));
  await page.screenshot({ path: join(evidence, "palette-command-dark.png") });
  await page.keyboard.press("Enter");

  const uvRow = page.getByTestId("palette-row").filter({ hasText: `Python ${venvVersion} · uv` });

  await uvRow.waitFor({ timeout: 20_000 });

  const choices = await rows(page);

  assert.match(choices.find((r) => r.includes(" · uv")) ?? "", /In use · uv · \.venv\/bin\/python/);
  assert.ok(
    choices.some((r) => r.includes(" · Host")),
    "the Host's Python is listed"
  );
  assert.ok(choices.at(-1)?.startsWith("Use automatic detection"));

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await page.screenshot({ path: join(evidence, `palette-interpreters-${theme}.png`) });
  }

  console.log(`Follow-up: ${choices.length} rows, uv in use, Host listed, automatic last`);

  // Choose the Host's Python: the Workspace's override, and the row says so.
  await page.getByTestId("palette-row").filter({ hasText: " · Host" }).first().click();
  await page.getByTestId("command-palette").waitFor({ state: "detached" });
  await until("the Host override", async () => (await popoverFact(page)).includes("Host"));
  await page
    .locator('[data-testid="language-pill"][data-kind="ready"]')
    .waitFor({ timeout: 120_000 });
  await page.screenshot({ path: join(evidence, "popover-host-light.png") });
  await closePopover(page);
  console.log("Chose the Host's Python; the row reads Host and the server came back ready");

  // Back to automatic detection.
  await appearance(page, "dark");
  await (await ask(page)).press("Enter");

  const auto = page.getByTestId("palette-row").filter({ hasText: "Use automatic detection" });

  await auto.waitFor({ timeout: 20_000 });
  assert.match((await auto.textContent()) ?? "", /Would use uv/);
  await page.screenshot({ path: join(evidence, "palette-override-dark.png") });
  await auto.click();
  await until("automatic again", async () => (await popoverFact(page)).includes("uv, automatic"));
  await closePopover(page);
  console.log("Use automatic detection cleared it");

  console.log("PASS: Python interpreter acceptance");
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
}
