/**
 * The shared terminal drawer in the real app on an isolated profile (build first):
 * node apps/desktop/scripts/terminalDrawerSmoke.ts --out <dir>. In each theme: a terminal
 * opened in Orchestrate shows in Edit with its output, still the same process; "Open in
 * terminal" from the Editor's right-click menu opens a tab there without switching modes;
 * hiding is shared.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import { scriptedElectron as electron, APP_DIR, stockElectronBinary } from "./lib/electron.ts";

const { values } = parseArgs({ options: { out: { type: "string" } } });

const out = values.out ?? join(tmpdir(), "polaris-terminal-drawer-smoke");

const profile = realpathSync(mkdtempSync(join(tmpdir(), "polaris-terminal-drawer-")));

const userData = join(profile, "user-data");

const workspace = join(profile, "shared");

const folder = join(workspace, "packages", "ui");

mkdirSync(out, { recursive: true });

mkdirSync(userData);

mkdirSync(folder, { recursive: true });

writeFileSync(join(folder, "button.ts"), 'export const label = "Run";\n');

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

const daemon = await startDaemon({ home: profile, benchHarness: true });

// SHOW=1 shows the window (hidden, xterm's WebGL glyphs can render at the wrong scale).
const app = await electron.launch({
  executablePath: stockElectronBinary(),
  args: [APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_HIDDEN: process.env.SHOW === "1" ? "0" : "1",
  },
});

const step = (message: string) => console.log(`✓ ${message}`);

const text = (page: Page, terminalId: string) =>
  page.evaluate<string | null>(
    `window.__polarisTerminal?.text(${JSON.stringify(terminalId)}) ?? null`
  );

const waitForText = async (page: Page, terminalId: string, needle: string) => {
  for (const end = Date.now() + 15_000; Date.now() < end;) {
    if ((await text(page, terminalId))?.includes(needle) === true) return;
    await page.waitForTimeout(100);
  }

  throw new Error(
    `terminal ${terminalId} never showed "${needle}":\n${await text(page, terminalId)}`
  );
};

const shownTerminal = async (page: Page) => {
  const surface = page.getByTestId("terminal-drawer").locator("[data-terminal-id]");

  await surface.waitFor({ timeout: 15_000 });

  const id = await surface.getAttribute("data-terminal-id");

  assert.ok(id !== null);

  return id;
};

/** Types into the shown terminal (clicked first, so it has the keyboard). */
const run = async (page: Page, line: string) => {
  await page.getByTestId("terminal-drawer").locator("[data-terminal-id]").click();
  await page.keyboard.type(`${line}\n`);
};

const tabs = (page: Page) => page.getByTestId("terminal-tab").allInnerTexts();

const theme = async (page: Page, name: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${name}" } })`
  );
  await page.locator(`html[data-theme="${name}"]`).waitFor();
};

const flow = async (page: Page, name: string, first: boolean) => {
  await theme(page, name);
  await page.keyboard.press("Meta+1");
  await page.getByTestId("terminal-dock").waitFor({ timeout: 20_000 });

  if (first) await page.keyboard.press("Control+Backquote");
  else await page.getByTestId("terminal-toggle").click();

  const shell = await shownTerminal(page);

  await run(page, `echo ${name}-$((6 * 7))`);
  await waitForText(page, shell, `${name}-42`);
  await page.screenshot({ path: join(out, `${name}-1-orchestrate.png`) });
  step(`${name}: terminal ${shell} open in Orchestrate`);

  const started = Date.now();

  await page.keyboard.press("Meta+3");
  await page.getByTestId("edit-mode").waitFor({ timeout: 30_000 });
  assert.equal(await shownTerminal(page), shell, "Edit shows the same terminal");
  const switched = Date.now() - started;

  assert.ok((await text(page, shell))?.includes(`${name}-42`), "Edit shows its scrollback");
  await run(page, `echo still-$((1 + 1)) $$`);
  await waitForText(page, shell, "still-2");
  await page.screenshot({ path: join(out, `${name}-2-edit-same-terminal.png`) });
  step(`${name}: Edit shows terminal ${shell} with its output, same process (${switched} ms)`);

  const before = (await tabs(page)).length;

  // Open in terminal from the Editor's menu on a file in packages/ui.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+P");
  await page.getByTestId("finder-input").fill("button.ts");
  await page.getByTestId("finder-item").first().waitFor({ timeout: 20_000 });
  await page.keyboard.press("Enter");
  await page
    .locator('[data-testid="editor-tab"][aria-selected="true"][title$="button.ts"]')
    .waitFor();
  await page.locator(".cm-line").first().click({ button: "right" });
  await page.getByTestId("editor-menu").getByTestId("editor-menu-open-in-terminal").click();
  await page.getByTestId("terminal-tab").nth(before).waitFor();
  const opened = await shownTerminal(page);

  assert.notEqual(opened, shell);
  assert.ok(await page.getByTestId("edit-mode").isVisible(), "Open in terminal stays in Edit");
  await run(page, "pwd");
  await waitForText(page, opened, "packages/ui");
  assert.deepEqual((await tabs(page)).at(-1), "ui");
  await page.screenshot({ path: join(out, `${name}-3-edit-open-in-terminal.png`) });
  step(`${name}: Open in terminal opened "ui" in Edit, no mode switch`);

  await page.keyboard.press("Control+Backquote");
  await page.getByTestId("terminal-toggle").waitFor();
  await page.screenshot({ path: join(out, `${name}-4-edit-hidden.png`) });
  await page.keyboard.press("Meta+1");
  await page.getByTestId("terminal-toggle").waitFor({ timeout: 20_000 });
  assert.equal(await page.getByTestId("terminal-drawer").count(), 0, "Hidden in both modes");
  await page.keyboard.press("Control+Backquote");
  assert.equal(await shownTerminal(page), opened, "Orchestrate shows the tab Edit opened");
  assert.equal((await tabs(page)).length, before + 1);
  await page.screenshot({ path: join(out, `${name}-5-orchestrate-shared-tabs.png`) });
  step(`${name}: hiding is shared, and Orchestrate has Edit's tab`);

  // Close what this pass opened, so the next theme starts from the shell alone.
  await page.getByRole("button", { name: "Close ui" }).last().click();
  await page.keyboard.press("Control+Backquote");
};

try {
  const page = await app.firstWindow();

  // Sized natively: setViewportSize forces a 1× scale that shrinks xterm's WebGL glyphs on Retina.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900)
  );
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(workspace)}, name: "shared" } })`
  );
  await flow(page, "dark", true);
  await flow(page, "light", false);

  const times = await page.evaluate<ReadonlyArray<number>>("window.__polaris?.switchTimes() ?? []");

  console.log(`Evidence in ${out}; Workspace switch times: ${JSON.stringify(times)}`);
} finally {
  await app.close();
  await daemon.stop();
}
