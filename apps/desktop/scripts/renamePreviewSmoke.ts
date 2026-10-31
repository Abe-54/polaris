/**
 * The multi-file rename preview in the real app on an isolated profile (Paper L7, L7b):
 * node apps/desktop/scripts/renamePreviewSmoke.ts (build first). An exported symbol used in
 * 3 files: Cancel leaves them unchanged; Accept lands unsaved edits, keeping a file's own
 * unsaved edits; one ⌘Z undoes everywhere; a file changed on disk refuses with a clear line.
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
  stockElectronBinary,
} from "./lib/electron.ts";

const profile = realpathSync(mkdtempSync(join(tmpdir(), "polaris-rename-preview-")));

const userData = join(profile, "user-data");

const project = join(profile, "retry-demo");

const evidence = join(REPO_ROOT, ".dagr/evidence/slice-4c");

mkdirSync(userData);

mkdirSync(join(project, "src"), { recursive: true });

mkdirSync(evidence, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

writeFileSync(
  join(project, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: { strict: true, module: "esnext", target: "es2022" },
    include: ["src"],
  })
);

const files = {
  "delay.ts":
    "export const BASE_DELAY_MS = 500;\n\nexport const delayFor = (attempt: number) => BASE_DELAY_MS * attempt;\n",
  "retry.ts":
    'import { BASE_DELAY_MS } from "./delay";\n\nexport const first = BASE_DELAY_MS;\nexport const second = BASE_DELAY_MS * 2;\n',
  "backoff.ts":
    'import { BASE_DELAY_MS } from "./delay";\n\nexport const cap = BASE_DELAY_MS * 10;\n',
};

for (const [name, text] of Object.entries(files)) writeFileSync(join(project, "src", name), text);

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

const until = async (what: string, check: () => Promise<boolean>, ms = 60_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for ${what}`);
};

const code = (page: Page) => page.locator(".cm-content").first().textContent();

const open = async (page: Page, name: string) => {
  await page
    .getByTestId("tree-row")
    .filter({ has: page.getByText(name, { exact: true }) })
    .click();
  await page
    .locator('[data-testid="editor-tab"][aria-selected="true"]')
    .filter({ hasText: name })
    .waitFor();
  await page.locator(".cm-content").first().waitFor();
};

const appearance = async (page: Page, theme: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "balanced" } })`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(300);
};

/** F2 on BASE_DELAY_MS in delay.ts, renaming it to `to`, until the preview shows. */
const rename = async (page: Page, to: string) => {
  await open(page, "delay.ts");
  await page.locator(".cm-line").first().click();
  await page.keyboard.press("Home");

  for (let i = 0; i < 15; i++) await page.keyboard.press("ArrowRight");

  await until(
    "the rename preview",
    async () => {
      if ((await page.getByTestId("rename-preview").count()) > 0) return true;

      if ((await page.getByTestId("rename-field").count()) === 0) await page.keyboard.press("F2");
      await page.getByLabel("New name").fill(to);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1500);

      if ((await page.getByTestId("rename-field").count()) > 0) await page.keyboard.press("Escape");

      return (await page.getByTestId("rename-preview").count()) > 0;
    },
    120_000
  );
};

try {
  daemon = await startDaemon({ home: profile, benchHarness: true });
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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(project)}, name: "retry-demo" } })`
  );
  await appearance(page, "dark");
  await page.keyboard.press("Meta+3");
  await page
    .getByTestId("tree-row")
    .filter({ has: page.getByText("src", { exact: true }) })
    .click({ timeout: 20_000 });

  // retry.ts has its own unsaved edit before the rename.
  await open(page, "retry.ts");
  await page.locator(".cm-line").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type("// mine");
  await open(page, "delay.ts");
  await page
    .locator('[data-testid="language-pill"]:is([data-kind="ready"], [data-kind="bundled"])')
    .waitFor({ timeout: 240_000 });

  // Cancel (esc) changes nothing.
  await rename(page, "RETRY_DELAY_MS");
  assert.equal(await page.getByTestId("rename-file").count(), 3);
  await page.keyboard.press("Escape");
  await page.getByTestId("rename-preview").waitFor({ state: "detached" });
  assert.ok((await code(page))?.includes("BASE_DELAY_MS"));
  console.log("Cancel: nothing renamed");

  // The preview in both themes.
  await rename(page, "RETRY_DELAY_MS");
  const preview = page.getByTestId("rename-preview");
  assert.ok((await preview.textContent())?.includes("Rename in 3 files"));
  assert.ok((await preview.textContent())?.includes("unsaved edits kept"));
  await page.screenshot({ path: join(evidence, "rename-preview-dark.png") });
  await appearance(page, "light");
  await preview.getByTestId("rename-file").nth(1).getByRole("button").first().click();
  await page.screenshot({ path: join(evidence, "rename-preview-light.png") });
  await appearance(page, "dark");

  // Accept (⌘↵): every file renamed as unsaved edits; retry.ts keeps its own edit.
  await page.keyboard.press("Meta+Enter");
  await preview.waitFor({ state: "detached", timeout: 30_000 });
  await until(
    "delay.ts renamed",
    async () => (await code(page))?.includes("RETRY_DELAY_MS") ?? false
  );
  await open(page, "retry.ts");
  const retry = (await code(page)) ?? "";
  assert.ok(retry.includes("RETRY_DELAY_MS") && !retry.includes("BASE_DELAY_MS"), retry);
  assert.ok(retry.includes("// mine"), "retry.ts keeps its unsaved edit");
  await open(page, "backoff.ts");
  assert.ok((await code(page))?.includes("RETRY_DELAY_MS"));
  assert.equal(await page.getByTestId("refactor-recovery").count(), 0, "no recovery strip");
  await page.screenshot({ path: join(evidence, "rename-accepted-dark.png") });
  console.log("Accept: 3 files renamed as unsaved edits; retry.ts kept its own edit");

  // One ⌘Z, in any file it touched, undoes it everywhere.
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Meta+z");
  await until(
    "backoff.ts restored",
    async () => (await code(page))?.includes("BASE_DELAY_MS") ?? false
  );
  await open(page, "delay.ts");
  assert.ok((await code(page))?.includes("BASE_DELAY_MS"));
  await open(page, "retry.ts");
  const restored = (await code(page)) ?? "";
  assert.ok(restored.includes("BASE_DELAY_MS") && restored.includes("// mine"), restored);
  console.log("⌘Z: undone in all 3 files; retry.ts still has its own edit");

  // A file changed on disk since the preview refuses with one clear line.
  await rename(page, "RETRY_DELAY_MS");
  writeFileSync(join(project, "src", "backoff.ts"), files["backoff.ts"] + "// changed elsewhere\n");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Meta+Enter");
  const alert = page.getByTestId("rename-preview").getByRole("alert");
  await alert.waitFor({ timeout: 30_000 });
  console.log(`Stale: ${await alert.textContent()}`);
  await page.screenshot({ path: join(evidence, "rename-stale-dark.png") });
  await page.keyboard.press("Escape");
  await page.getByTestId("rename-preview").waitFor({ state: "detached" });
  assert.ok((await code(page))?.includes("BASE_DELAY_MS"), "nothing renamed after a refusal");
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(evidence, "rename-stale-after-dark.png") });
  console.log(
    `Recovery strip after refusal: ${await page.getByTestId("refactor-recovery").count()}`
  );
  console.log("PASS");
} catch (error) {
  const page = app === undefined ? null : await app.firstWindow();
  await page?.screenshot({ path: join(evidence, "rename-failure.png") }).catch(() => undefined);
  throw error;
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();
  rmSync(profile, { recursive: true, force: true });
}
