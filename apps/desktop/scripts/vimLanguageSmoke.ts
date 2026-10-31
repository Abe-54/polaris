/**
 * Vim's language keys in the real app on an isolated profile: node apps/desktop/scripts/vimLanguageSmoke.ts
 * (build first). gd and gD go to the definition, ⌃o and ⌃i return like Back and Forward, K shows
 * the hover, ]d and [d walk the problems; each runs its registry command.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const profile = realpathSync(mkdtempSync(join(tmpdir(), "polaris-vim-language-")));

const userData = join(profile, "user-data");

const evidence = join(REPO_ROOT, ".dagr/evidence/slice-4a");

const name = "vim-language-acceptance.ts";

const path = join(REPO_ROOT, name);

assert.equal(existsSync(path), false, "Never overwrite a file");

mkdirSync(userData);

mkdirSync(evidence, { recursive: true });

writeFileSync(path, "export const value: string = 123;\nexport const other = value;\n");

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ welcomeSeen: true, sessions: { editorVim: true } })
);

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

const until = async (what: string, check: () => Promise<boolean> | boolean, ms = 90_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${what}`);
};

const at = async (page: Page, line: number, column?: number) =>
  until(`Ln ${line}${column === undefined ? "" : `, Col ${column}`}`, async () => {
    const text = await page.evaluate<string>("document.body.textContent ?? ''");

    return text.includes(column === undefined ? `Ln ${line},` : `Ln ${line}, Col ${column}`);
  });

const vim = async (page: Page, keys: string) => {
  for (const key of keys) await page.keyboard.press(key);
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
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(REPO_ROOT)}, name: "polaris" } })`
  );
  await page.evaluate(
    `window.polaris.request("settings.setSessions", { patch: { editorVim: true } })`
  );
  await page.keyboard.press("Meta+3");
  await page.getByTestId("explorer").waitFor({ timeout: 30_000 });
  await page
    .getByTestId("tree-row")
    .filter({ has: page.getByText(name, { exact: true }) })
    .click({ timeout: 15_000 });
  await page.locator(".cm-content").first().waitFor({ timeout: 15_000 });
  await until(
    "vim's NORMAL mode",
    async () => (await page.getByText("NORMAL", { exact: true }).count()) > 0
  );
  // The server answers once its diagnostic is drawn.
  await until(
    "the server's diagnostic",
    async () => (await page.locator(".cm-lintRange-error").count()) > 0
  );
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Escape");

  // On "value" in line 2: gd jumps to its definition, ⌃o comes back, ⌃i goes again.
  await vim(page, "ggj0fv");
  await at(page, 2, 22);
  await vim(page, "gd");
  await at(page, 1, 14);
  await page.keyboard.press("Control+o");
  await at(page, 2, 22);
  await page.keyboard.press("Control+i");
  await at(page, 1, 14);
  console.log("gd went to the definition; ⌃o came back; ⌃i went again");

  await page.keyboard.press("Control+o");
  await at(page, 2, 22);
  await vim(page, "gD");
  await at(page, 1, 14);
  console.log("gD went to the definition (no declaration in the protocol)");

  await vim(page, "ggj0fv");
  await vim(page, "K");
  await until("the hover", async () =>
    (await page.locator(".cm-tooltip").allTextContents()).some((t) =>
      t.includes("const value: string")
    )
  );
  await page.screenshot({ path: join(evidence, "vim-hover.png") });
  console.log("K showed the hover");

  await page.keyboard.press("Escape");
  await vim(page, "gg0");
  await vim(page, "]d");
  await at(page, 1, 14);
  await vim(page, "j0");
  await vim(page, "[d");
  await at(page, 1, 14);
  console.log("]d and [d walked to the problem");
  console.log("PASS: vim language keys");
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();
  rmSync(path, { force: true });
  rmSync(profile, { recursive: true, force: true });
}
